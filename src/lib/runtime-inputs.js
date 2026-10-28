// Shared by k6 initialisation and the container's cookie-file validation.
export function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required; supply it through environment secrets`);
  }
  return value.trim();
}

export function parseSessionCookies(csv) {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  const cookies = rows.map((row) => row.trim()).filter(Boolean);
  if (header !== 'cookieHeader' || !cookies.length || cookies.some((row) => !/^session=\S+$/.test(row))) {
    throw new Error('Fresh session cookies are required; regenerate the session cookie CSV before running k6');
  }
  return cookies;
}
