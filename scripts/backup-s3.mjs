export function awsEndpointArgs(env = process.env) {
  const rawEndpoint = env.AWS_ENDPOINT_URL?.trim();
  if (!rawEndpoint) return [];

  let endpoint;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error('AWS_ENDPOINT_URL must be a valid HTTPS URL.');
  }

  if (endpoint.protocol !== 'https:') {
    throw new Error('AWS_ENDPOINT_URL must use HTTPS.');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('AWS_ENDPOINT_URL must not include credentials.');
  }
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('AWS_ENDPOINT_URL must not include a path, query, or hash.');
  }

  endpoint.pathname = '';
  return ['--endpoint-url', endpoint.toString().replace(/\/$/, '')];
}

export function s3CopyArgs(source, destination, env = process.env) {
  return [
    's3',
    'cp',
    source,
    destination,
    '--only-show-errors',
    ...awsEndpointArgs(env),
  ];
}

export function s3ListObjectsArgs(destination, env = process.env) {
  const prefix = destination.prefix ? `${destination.prefix}/` : '';
  return [
    's3api',
    'list-objects-v2',
    '--bucket',
    destination.bucket,
    '--prefix',
    `${prefix}moa-studio-supabase-`,
    '--output',
    'json',
    ...awsEndpointArgs(env),
  ];
}

export function s3DeleteObjectArgs(bucket, key, env = process.env) {
  return [
    's3api',
    'delete-object',
    '--bucket',
    bucket,
    '--key',
    key,
    '--output',
    'json',
    ...awsEndpointArgs(env),
  ];
}
