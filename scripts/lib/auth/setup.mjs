// First-run setup status: the dashboard shows its setup screen only while no account exists.
/** { needsSetup: true } when there are no users yet, else { needsSetup: false }. */
export async function setupStatus({ countUsers }) {
  return { needsSetup: (await countUsers()) === 0 };
}