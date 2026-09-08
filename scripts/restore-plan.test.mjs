import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRestoreLists,
  extractApplicationPrivileges,
  parseCopyBlocks,
} from './restore-plan.mjs';

test('buildRestoreLists separates application schema objects from selected restore data', () => {
  const toc = `; Archive created at test time
1; 2615 2200 SCHEMA - public postgres
2; 1259 101 TABLE public projects postgres
3; 1259 102 TABLE moa_private audit_events postgres
4; 0 101 TABLE DATA public projects postgres
5; 0 102 TABLE DATA moa_private audit_events postgres
6; 0 201 TABLE DATA auth users supabase_auth_admin
7; 0 202 TABLE DATA auth schema_migrations supabase_auth_admin
8; 0 203 TABLE DATA auth instances supabase_auth_admin
9; 0 301 TABLE DATA storage buckets supabase_storage_admin
10; 0 302 TABLE DATA storage objects supabase_storage_admin
11; 0 401 SEQUENCE SET auth identities_id_seq supabase_auth_admin
12; 0 402 SEQUENCE SET public projects_id_seq postgres
13; 0 403 ACL public projects postgres
14; 0 404 POLICY storage objects read_public postgres
15; 0 405 POLICY storage buckets read_buckets postgres
16; 0 406 COMMENT - SCHEMA public postgres
17; 2604 407 DEFAULT auth refresh_tokens id supabase_auth_admin
`;

  assert.deepEqual(buildRestoreLists(toc), {
    schemaList: [
      '2; 1259 101 TABLE public projects postgres',
      '3; 1259 102 TABLE moa_private audit_events postgres',
      '13; 0 403 ACL public projects postgres',
      '14; 0 404 POLICY storage objects read_public postgres',
    ].join('\n') + '\n',
    dataList: [
      '4; 0 101 TABLE DATA public projects postgres',
      '5; 0 102 TABLE DATA moa_private audit_events postgres',
      '6; 0 201 TABLE DATA auth users supabase_auth_admin',
      '9; 0 301 TABLE DATA storage buckets supabase_storage_admin',
      '11; 0 401 SEQUENCE SET auth identities_id_seq supabase_auth_admin',
      '12; 0 402 SEQUENCE SET public projects_id_seq postgres',
    ].join('\n') + '\n',
    dataTables: [
      { schema: 'public', table: 'projects' },
      { schema: 'moa_private', table: 'audit_events' },
      { schema: 'auth', table: 'users' },
      { schema: 'storage', table: 'buckets' },
    ],
    excludedInternalDataTables: [
      'auth.schema_migrations',
      'auth.instances',
      'storage.objects',
    ],
  });
});

test('buildRestoreLists supports custom application schemas', () => {
  const toc = `1; 1259 101 TABLE tenant_private jobs postgres
2; 0 101 TABLE DATA tenant_private jobs postgres
3; 1259 102 TABLE public projects postgres
4; 0 102 TABLE DATA public projects postgres
`;

  assert.deepEqual(buildRestoreLists(toc, ['tenant_private']), {
    schemaList: '1; 1259 101 TABLE tenant_private jobs postgres\n',
    dataList: '2; 0 101 TABLE DATA tenant_private jobs postgres\n',
    dataTables: [{ schema: 'tenant_private', table: 'jobs' }],
    excludedInternalDataTables: [],
  });
});

test('extractApplicationPrivileges keeps only single-line app schema privilege statements', () => {
  const schemaSql = `-- grants emitted by pg_dump
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON TABLE public.projects TO authenticated;
REVOKE ALL ON SCHEMA moa_private FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "moa_private" GRANT SELECT ON TABLES TO authenticated;
GRANT USAGE ON SCHEMA auth TO anon;
GRANT SELECT ON TABLE storage.buckets TO authenticated;
`;

  assert.equal(
    extractApplicationPrivileges(schemaSql),
    [
      'GRANT USAGE ON SCHEMA public TO anon;',
      'GRANT SELECT ON TABLE public.projects TO authenticated;',
      'REVOKE ALL ON SCHEMA moa_private FROM PUBLIC;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "moa_private" GRANT SELECT ON TABLES TO authenticated;',
    ].join('\n') + '\n',
  );
});

test('extractApplicationPrivileges rejects multiline privilege candidates', () => {
  const schemaSql = `GRANT SELECT ON TABLE public.projects
TO authenticated;
`;

  assert.throws(
    () => extractApplicationPrivileges(schemaSql),
    /Malformed multiline privilege statement starting at line 1/,
  );
});

test('parseCopyBlocks parses quoted and unquoted schema-qualified COPY blocks', () => {
  const dataSql = `SET search_path = public, pg_catalog;
COPY "public"."projects" ("id", "display name", path) FROM stdin;
1	Demo	\\N
2	Other	contains\\tescape
\\.

COPY moa_private.audit_events (id, payload) FROM stdin;
7	{"event":"created"}
\\.
`;

  assert.deepEqual(parseCopyBlocks(dataSql), [
    {
      schema: 'public',
      table: 'projects',
      columns: ['id', 'display name', 'path'],
      copySql: 'COPY "public"."projects" ("id", "display name", path) FROM stdin;',
      rows: ['1\tDemo\t\\N', '2\tOther\tcontains\\tescape'],
    },
    {
      schema: 'moa_private',
      table: 'audit_events',
      columns: ['id', 'payload'],
      copySql: 'COPY moa_private.audit_events (id, payload) FROM stdin;',
      rows: ['7\t{"event":"created"}'],
    },
  ]);
});

test('parseCopyBlocks rejects malformed COPY input', () => {
  assert.throws(
    () => parseCopyBlocks('COPY projects (id) FROM stdin;\n1\n\\.\n'),
    /COPY target must be schema-qualified/,
  );
  assert.throws(
    () => parseCopyBlocks('COPY public.projects (id) FROM stdin;\n1\n'),
    /Unterminated COPY block for public\.projects/,
  );
  assert.throws(
    () => parseCopyBlocks('COPY public.projects (id) FROM stdin;\n1\n\\.\nCOPY public.projects (id) FROM stdin;\n2\n\\.\n'),
    /Duplicate COPY block for public\.projects/,
  );
  assert.throws(
    () => parseCopyBlocks('COPY public.projects (*) FROM stdin;\n1\n\\.\n'),
    /Unsupported identifier in COPY/,
  );
});
