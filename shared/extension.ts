export function extensionOrigin(redirect: string) {
  const match = /^https:\/\/([a-p]{32})\.chromiumapp\.org\/drop-it$/.exec(
    redirect,
  );
  return match ? `chrome-extension://${match[1]}` : undefined;
}
