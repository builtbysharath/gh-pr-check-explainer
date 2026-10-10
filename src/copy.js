// Fixed, trusted script shared by the hosted page and portable HTML reports.
// Report data stays in escaped text nodes, never in this script.
export const copyScript = `
for (const button of document.querySelectorAll('[data-copy-target]')) {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    const status = document.getElementById(button.dataset.copyStatus);
    status.textContent = '';
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(target.value ?? target.textContent);
      status.textContent = 'Copied to clipboard.';
    } catch {
      status.textContent = 'Could not copy. Select the text and copy it manually.';
    } finally {
      button.disabled = false;
    }
  });
}
`;
