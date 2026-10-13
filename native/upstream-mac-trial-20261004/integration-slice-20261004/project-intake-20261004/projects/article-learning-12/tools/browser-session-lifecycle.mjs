export async function closeControlledBrowserSession({ input, browser, captureName = 'last-desktop-state.png' }) {
  try {
    await browser.capture(captureName);
    await browser.close();
  } finally {
    input.close();
  }
  return { desktopInteractionFinished: true };
}
