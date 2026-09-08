const APP_SCHEMA_DEFAULTS = ['public', 'moa_private'];
const AUTH_DATA_EXCLUDES = new Set(['schema_migrations', 'instances']);
const COPY_START = /^COPY\s+/;
const PRIVILEGE_START = /^(?:GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)\b/;
const KNOWN_TOC_DESCRIPTIONS = [
  'TABLE DATA',
  'SEQUENCE SET',
  'DEFAULT ACL',
  'DEFAULT',
  'MATERIALIZED VIEW DATA',
  'CONSTRAINT',
  'FK CONSTRAINT',
  'ROW SECURITY',
  'POLICY',
  'COMMENT',
  'SCHEMA',
  'TABLE',
  'INDEX',
  'TRIGGER',
  'FUNCTION',
  'TYPE',
  'SEQUENCE',
  'ACL',
];

function parseTocLine(line) {
  const match = /^(\d+);\s+\d+\s+\d+\s+(.+)$/.exec(line);
  if (!match) return null;
  const [, id, rest] = match;
  const description = KNOWN_TOC_DESCRIPTIONS.find(value => rest.startsWith(`${value} `));
  if (!description) {
    throw new Error(`Unsupported pg_restore TOC entry type: ${line}`);
  }
  const remainder = rest.slice(description.length).trim();
  const firstSpace = remainder.indexOf(' ');
  if (firstSpace === -1) {
    throw new Error(`Malformed pg_restore TOC entry: ${line}`);
  }
  const namespace = remainder.slice(0, firstSpace);
  const tag = remainder.slice(firstSpace + 1).trim().replace(/\s+\S+$/, '');
  return {
    id,
    line,
    description,
    namespace,
    tag,
    table: tag.split(/\s+/)[0],
  };
}

function tocList(lines) {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function isPublicSchemaEntry(entry) {
  return entry.description === 'SCHEMA' && entry.namespace === '-' && entry.tag === 'public';
}

function isPublicSchemaComment(entry) {
  return entry.description === 'COMMENT' && entry.namespace === '-' && entry.tag === 'SCHEMA public';
}

function isStorageObjectsPolicy(entry) {
  return entry.description === 'POLICY' && entry.namespace === 'storage' && entry.table === 'objects';
}

function isApplicationSchemaEntry(entry, applicationSchemas) {
  return applicationSchemas.has(entry.namespace)
    && entry.description !== 'TABLE DATA'
    && entry.description !== 'SEQUENCE SET'
    && !isPublicSchemaEntry(entry)
    && !isPublicSchemaComment(entry);
}

function isSelectedDataEntry(entry, applicationSchemas) {
  if (entry.description === 'TABLE DATA') {
    if (applicationSchemas.has(entry.namespace)) return true;
    if (entry.namespace === 'auth') return !AUTH_DATA_EXCLUDES.has(entry.table);
    return entry.namespace === 'storage' && entry.table === 'buckets';
  }
  return entry.description === 'SEQUENCE SET' && (entry.namespace === 'auth' || applicationSchemas.has(entry.namespace));
}

function isExcludedInternalDataEntry(entry, applicationSchemas) {
  if (entry.description !== 'TABLE DATA' || applicationSchemas.has(entry.namespace)) return false;
  if (entry.namespace === 'auth') return AUTH_DATA_EXCLUDES.has(entry.table);
  return entry.namespace === 'storage' && entry.table !== 'buckets';
}

export function buildRestoreLists(pgRestoreTocText, applicationSchemas = APP_SCHEMA_DEFAULTS) {
  const appSchemas = new Set(applicationSchemas);
  const schemaLines = [];
  const dataLines = [];
  const dataTables = [];
  const excludedInternalDataTables = [];

  for (const line of pgRestoreTocText.split('\n')) {
    if (!line.trim() || line.startsWith(';')) continue;
    const entry = parseTocLine(line);
    if (!entry) continue;
    if (isApplicationSchemaEntry(entry, appSchemas) || isStorageObjectsPolicy(entry)) {
      schemaLines.push(entry.line);
    }
    if (isSelectedDataEntry(entry, appSchemas)) {
      dataLines.push(entry.line);
      if (entry.description === 'TABLE DATA') dataTables.push({ schema: entry.namespace, table: entry.table });
    } else if (isExcludedInternalDataEntry(entry, appSchemas)) {
      excludedInternalDataTables.push(`${entry.namespace}.${entry.table}`);
    }
  }

  return {
    schemaList: tocList(schemaLines),
    dataList: tocList(dataLines),
    dataTables,
    excludedInternalDataTables,
  };
}

function sqlIdentifierPattern(schema) {
  const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = `"${escaped.replaceAll('"', '""')}"`;
  return `(?:${quoted}|${escaped})(?=\\s|\\.|,|;)`;
}

function privilegeTargetsSchema(statement, schemas) {
  return schemas.some(schema => {
    const identifier = sqlIdentifierPattern(schema);
    return new RegExp(`\\b(?:ON|IN)\\s+SCHEMA\\s+${identifier}`).test(statement)
      || new RegExp(`\\bON\\s+(?:TABLE|SEQUENCE|FUNCTION|ROUTINE|PROCEDURE)\\s+${identifier}\\.`).test(statement);
  });
}

export function extractApplicationPrivileges(schemaSql, schemas = APP_SCHEMA_DEFAULTS) {
  const selected = [];
  const lines = schemaSql.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('--')) continue;
    if (!PRIVILEGE_START.test(line)) continue;
    if (!line.endsWith(';')) {
      throw new Error(`Malformed multiline privilege statement starting at line ${index + 1}`);
    }
    if (privilegeTargetsSchema(line, schemas)) selected.push(line);
  }
  return selected.length === 0 ? '' : `${selected.join('\n')}\n`;
}

function readIdentifier(input, offset) {
  if (input[offset] === '"') {
    let value = '';
    let index = offset + 1;
    while (index < input.length) {
      if (input[index] === '"' && input[index + 1] === '"') {
        value += '"';
        index += 2;
      } else if (input[index] === '"') {
        return { value, next: index + 1 };
      } else {
        value += input[index];
        index += 1;
      }
    }
    throw new Error(`Unsupported unterminated quoted identifier in COPY: ${input}`);
  }
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(input.slice(offset));
  if (!match) throw new Error(`Unsupported identifier in COPY: ${input}`);
  return { value: match[0], next: offset + match[0].length };
}

function skipSpaces(input, offset) {
  let index = offset;
  while (input[index] === ' ') index += 1;
  return index;
}

function parseQualifiedIdentifier(input) {
  let index = skipSpaces(input, 0);
  const schema = readIdentifier(input, index);
  index = skipSpaces(input, schema.next);
  if (input[index] !== '.') throw new Error(`COPY target must be schema-qualified: ${input}`);
  index = skipSpaces(input, index + 1);
  const table = readIdentifier(input, index);
  index = skipSpaces(input, table.next);
  if (index !== input.length) throw new Error(`Unsupported COPY target identifier: ${input}`);
  return { schema: schema.value, table: table.value };
}

function parseColumnList(input) {
  const columns = [];
  let index = 0;
  while (index < input.length) {
    index = skipSpaces(input, index);
    const column = readIdentifier(input, index);
    columns.push(column.value);
    index = skipSpaces(input, column.next);
    if (index === input.length) break;
    if (input[index] !== ',') throw new Error(`Unsupported COPY column list: ${input}`);
    index += 1;
  }
  if (columns.length === 0) throw new Error(`COPY must include columns: ${input}`);
  return columns;
}

function parseCopyStatement(line) {
  const match = /^COPY\s+(.+?)\s+\((.*)\)\s+FROM\s+stdin;$/.exec(line);
  if (!match) throw new Error(`Unsupported COPY statement: ${line}`);
  return {
    ...parseQualifiedIdentifier(match[1]),
    columns: parseColumnList(match[2]),
    copySql: line,
  };
}

export function parseCopyBlocks(dataSql) {
  const blocks = [];
  const seen = new Set();
  const lines = dataSql.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!COPY_START.test(line)) continue;
    const block = parseCopyStatement(line);
    const key = `${block.schema}.${block.table}`;
    if (seen.has(key)) throw new Error(`Duplicate COPY block for ${key}`);
    seen.add(key);
    const rows = [];
    index += 1;
    while (index < lines.length && lines[index] !== '\\.') {
      rows.push(lines[index]);
      index += 1;
    }
    if (index >= lines.length) throw new Error(`Unterminated COPY block for ${key}`);
    blocks.push({ ...block, rows });
  }
  return blocks;
}
