// The local ASQL port. AIOS_MYSQL_PORT wins when set; otherwise each local install gets its own port from
// CONVERGE_PORT (3307 on the default 8787, else 20000 + the port modulo 10000), so two installs do not share one ASQL.
export function asqlPort(env) {
  if (env.AIOS_MYSQL_PORT) return Number(env.AIOS_MYSQL_PORT);
  if (!env.CONVERGE_PORT || env.CONVERGE_PORT === '8787') return 3307;
  return 20000 + (Number(env.CONVERGE_PORT) % 10000);
}