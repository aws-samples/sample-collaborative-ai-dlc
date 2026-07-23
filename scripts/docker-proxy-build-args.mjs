const proxyVariableNames = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'FTP_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'ftp_proxy',
  'no_proxy',
  'all_proxy',
];

const buildArgs = Object.fromEntries(
  proxyVariableNames
    .filter((name) => typeof process.env[name] === 'string' && process.env[name].length > 0)
    .map((name) => [name, process.env[name]]),
);

process.stdout.write(JSON.stringify(buildArgs));
