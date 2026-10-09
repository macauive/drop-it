// This page is deliberately static: no account data or client-side scripts.
// The caller supplies an HTML-escaped publisher name.
export function renderAboutPage(publisher: string) {
  const icon = (paths: string, className = "") =>
    `<svg class="${className}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const arrow = icon('<path d="M7 17 17 7M7 7h10v10"/>');
  const drop = icon(
    '<path d="M12 3c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 14 0c0-2-1-3.9-3-5.5S12.5 5.5 12 3Z"/>',
  );
  const bookmark = icon('<path d="M6 4h12v17l-6-4-6 4V4Z"/>');
  const search = icon(
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  );
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="A private place for the ideas, links, screenshots and files you want to come back to. Meet Drop It.">
  <title>About · Drop It</title>
  <style>
    :root {
      font-family:
        Inter,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      color: #242932;
      background: #f8f9fb;
      font-synthesis: none;
      --blue: #1764c0;
      --muted: #626c78;
      --line: #e0e5ec;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
    }
    a {
      color: inherit;
      text-decoration: none;
      text-underline-offset: 4px;
    }
    a:focus-visible {
      outline: 3px solid var(--blue);
      outline-offset: 5px;
    }
    a:hover {
      text-decoration: underline;
    }
    svg {
      flex-shrink: 0;
    }
    h1,
    h2,
    h3,
    p {
      margin: 0;
    }
    p {
      line-height: 1.7;
    }
    .container {
      width: min(1120px, calc(100% - 80px));
      margin-inline: auto;
    }
    .skip {
      position: absolute;
      top: 12px;
      left: 12px;
      transform: translateY(-200%);
      padding: 12px;
      background: white;
      z-index: 5;
    }
    .skip:focus {
      transform: none;
    }
    header {
      border-bottom: 1px solid var(--line);
    }
    .navigation {
      min-height: 88px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 21px;
      font-weight: 700;
      letter-spacing: -0.7px;
    }
    .brand-mark {
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      color: white;
      background: var(--blue);
      border-radius: 10px;
    }
    nav {
      display: flex;
      align-items: center;
      gap: 30px;
      font-size: 14px;
      font-weight: 500;
    }
    .nav-library {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }
    .nav-library svg {
      width: 17px;
      height: 17px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.08fr 1fr;
      gap: 64px;
      align-items: center;
      padding-block: 90px 76px;
    }
    h1 {
      font-size: clamp(46px, 5.2vw, 68px);
      letter-spacing: -3.5px;
      line-height: 1.05;
      font-weight: 650;
    }
    h1 span {
      color: var(--blue);
    }
    .intro {
      max-width: 435px;
      margin-top: 25px;
      color: var(--muted);
      font-size: 17px;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 24px;
      padding: 15px 20px;
      border-radius: 8px;
      background: var(--blue);
      color: white;
      font-size: 14px;
      font-weight: 600;
      min-height: 48px;
    }
    .button:hover {
      background: #124f9a;
      text-decoration: none;
    }
    .button svg {
      width: 18px;
      height: 18px;
    }
    .hero .button {
      margin-top: 30px;
    }
    .collection {
      position: relative;
      padding: 28px;
      border: 1px solid #dae4f0;
      border-radius: 18px;
      background: #edf3fb;
      box-shadow: 0 20px 60px -40px #436d9d;
    }
    .collection-heading {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 23px;
      color: #536c88;
      font-size: 11px;
      letter-spacing: 1.5px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .collection-heading svg {
      width: 18px;
      height: 18px;
    }
    .sample {
      background: #fff;
      border: 1px solid #e1e7ef;
      border-radius: 10px;
      padding: 19px 20px;
      box-shadow: 0 5px 12px -10px #6681a2;
    }
    .sample + .sample {
      margin-top: 12px;
    }
    .sample-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .sample-type {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.1px;
      text-transform: uppercase;
      color: #667587;
    }
    .sample-top svg {
      width: 16px;
      height: 16px;
      color: #6381a5;
    }
    .sample h3 {
      font-size: 17px;
      letter-spacing: -0.4px;
      font-weight: 600;
      line-height: 1.4;
    }
    .sample p {
      font-size: 12px;
      line-height: 1.6;
      color: var(--muted);
      margin-top: 6px;
    }
    .sample-footer {
      display: flex;
      gap: 7px;
      margin-top: 16px;
      flex-wrap: wrap;
    }
    .tag {
      font-size: 10px;
      padding: 5px 8px;
      border-radius: 4px;
      color: #466488;
      background: #edf3fa;
    }
    .note {
      background: #fffdf7;
      border-color: #eee8d7;
    }
    .note .tag {
      background: #f4efdf;
      color: #76643b;
    }
    .collection-caption {
      text-align: center;
      margin-top: 19px;
      font-size: 11px;
      color: #536c88;
    }
    .purpose {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 64px;
      border-top: 1px solid var(--line);
      padding-block: 48px;
    }
    .section-label {
      font-size: 11px;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 600;
      margin-bottom: 15px;
    }
    h2 {
      font-size: 30px;
      line-height: 1.25;
      letter-spacing: -1px;
      font-weight: 600;
    }
    .purpose p {
      font-size: 15px;
      color: var(--muted);
      align-self: center;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      padding-block: 36px;
      margin-bottom: 56px;
    }
    .feature {
      padding-inline: 30px;
      border-left: 1px solid var(--line);
    }
    .feature:first-child {
      padding-left: 0;
      border-left: 0;
    }
    .feature:last-child {
      padding-right: 0;
    }
    .feature-icon {
      color: var(--blue);
      margin-bottom: 20px;
      display: block;
    }
    .feature h3 {
      font-size: 16px;
      letter-spacing: -0.3px;
      margin-bottom: 10px;
      font-weight: 600;
    }
    .feature p {
      font-size: 13px;
      color: var(--muted);
    }
    .privacy {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 64px;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 36px 40px;
      margin-bottom: 64px;
    }
    .privacy h2 {
      font-size: 26px;
      margin-bottom: 15px;
    }
    .privacy p {
      font-size: 13px;
      color: var(--muted);
    }
    .privacy a {
      display: inline-block;
      margin-top: 20px;
      font-size: 13px;
      color: var(--blue);
      font-weight: 600;
    }
    .privacy ul {
      padding: 0;
      margin: 0;
      list-style: none;
      display: grid;
      gap: 18px;
    }
    .privacy li {
      display: grid;
      grid-template-columns: 20px 1fr;
      gap: 10px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--muted);
    }
    .privacy li::before {
      content: "✓";
      color: var(--blue);
      font-weight: 600;
    }
    footer {
      border-top: 1px solid var(--line);
    }
    .footer-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding-block: 27px;
      color: var(--muted);
      font-size: 12px;
    }
    .footer-credit {
      line-height: 1.7;
      overflow-wrap: anywhere;
    }
    .footer-credit strong {
      color: #242932;
      font-weight: 600;
    }
    footer nav {
      gap: 24px;
      font-size: 12px;
    }
    @media (min-width: 1400px) {
      .hero {
        padding-block: 104px 88px;
      }
    }
    @media (max-width: 900px) {
      .container {
        width: calc(100% - 48px);
      }
      .hero {
        gap: 32px;
        padding-block: 60px;
      }
      .collection {
        padding: 20px;
      }
      .purpose,
      .privacy {
        gap: 32px;
      }
      h1 {
        letter-spacing: -2.5px;
      }
      .feature {
        padding-inline: 20px;
      }
      .privacy {
        padding: 30px;
      }
    }
    @media (max-width: 640px) {
      .container {
        width: calc(100% - 40px);
      }
      .navigation {
        min-height: 76px;
        gap: 16px;
      }
      nav {
        gap: 18px;
        font-size: 12px;
      }
      .brand {
        font-size: 19px;
      }
      .brand-mark {
        width: 32px;
        height: 32px;
      }
      .nav-library svg {
        display: none;
      }
      .hero {
        grid-template-columns: 1fr;
        gap: 38px;
        padding-block: 46px 40px;
      }
      h1 {
        font-size: 52px;
        letter-spacing: -2.5px;
      }
      .intro {
        font-size: 16px;
        margin-top: 22px;
      }
      .collection {
        padding: 22px;
      }
      .purpose {
        grid-template-columns: 1fr;
        gap: 18px;
        padding-block: 32px;
      }
      h2 {
        font-size: 27px;
      }
      .features {
        grid-template-columns: 1fr;
        padding-block: 8px;
        margin-bottom: 32px;
      }
      .feature,
      .feature:first-child,
      .feature:last-child {
        padding: 25px 0;
        border-left: 0;
      }
      .feature + .feature {
        border-top: 1px solid var(--line);
      }
      .feature-icon {
        margin-bottom: 13px;
      }
      .feature p {
        font-size: 14px;
      }
      .privacy {
        grid-template-columns: 1fr;
        gap: 26px;
        padding: 26px 22px;
        margin-bottom: 36px;
      }
      .footer-inner {
        align-items: flex-start;
        flex-direction: column;
        gap: 18px;
        padding-block: 24px;
      }
      .footer-inner nav {
        flex-wrap: wrap;
      }
    }
    @media (max-width: 360px) {
      nav {
        gap: 12px;
      }
      h1 {
        font-size: 46px;
      }
      .brand {
        gap: 7px;
      }
      .container {
        width: calc(100% - 32px);
      }
    }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header>
    <div class="container navigation">
      <a class="brand" href="/about" aria-label="Drop It — About"><span class="brand-mark">${drop}</span>Drop It</a>
      <nav aria-label="Main"><a href="/support">Support</a><a class="nav-library" href="/">Open library ${arrow}</a></nav>
    </div>
  </header>
  <main id="main" class="container">
    <section class="hero" aria-labelledby="about-title">
      <div>
        <h1 id="about-title">Keep what<br><span>matters.</span></h1>
        <p class="intro">Good ideas deserve more than an open tab. Give your links, notes, screenshots and files a private place to land.</p>
        <a class="button" href="/">Open your library ${arrow}</a>
      </div>
      <div class="collection" role="group" aria-label="Example drops in a library">
        <div class="collection-heading"><span>A few things worth keeping</span>${drop}</div>
        <article class="sample">
          <div class="sample-top"><span class="sample-type">Link</span>${bookmark}</div>
          <h3>Small spaces, thoughtful design</h3>
          <p>Ideas for a room that feels like your own.</p>
          <div class="sample-footer"><span class="tag">Inspiration</span><span class="tag">For later</span></div>
        </article>
        <article class="sample note">
          <div class="sample-top"><span class="sample-type">Note</span>${icon('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z"/>')}</div>
          <h3>What if we tried this?</h3>
          <p>A passing thought. A starting point for something.</p>
          <div class="sample-footer"><span class="tag">Ideas</span></div>
        </article>
        <article class="sample">
          <div class="sample-top"><span class="sample-type">File</span>${icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h5"/>')}</div>
          <h3>The plan for next weekend</h3>
          <p>The details you’ll be glad you kept.</p>
        </article>
        <p class="collection-caption">Example drops. Endless possibilities.</p>
      </div>
    </section>
    <section class="purpose" aria-labelledby="purpose-title">
      <div><div class="section-label">Why Drop It exists</div><h2 id="purpose-title">Save it now.<br>Come back with a purpose.</h2></div>
      <p>The useful things you find shouldn’t disappear into scattered tabs and forgotten screenshots. Drop It brings the material you choose to save into one library, with the context to make it useful again.</p>
    </section>
    <section class="features" aria-label="How Drop It works">
      <article class="feature">${icon('<path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>', "feature-icon")}<h3>Drop it in.</h3><p>Capture a thought, save a link, or add a screenshot or supported file. Keep the original alongside your notes.</p></article>
      <article class="feature">${icon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>', "feature-icon")}<h3>Make it your own.</h3><p>Group related drops into pools, add tags and notes, and bookmark the ones you want close at hand.</p></article>
      <article class="feature"><span class="feature-icon">${search}</span><h3>Find your way back.</h3><p>Search your library and revisit the source. Connect ChatGPT to work with your drops in a conversation.</p></article>
    </section>
    <section class="privacy" aria-labelledby="privacy-title">
      <div><h2 id="privacy-title">Your personal library</h2><p>A private space for what you choose to keep, with controls for how you use it.</p><a href="/privacy">Read the privacy policy &rarr;</a></div>
      <ul><li>Save only what you choose to share. Saved links aren’t automatically fetched.</li><li>AI-generated details are suggestions to review. AI search is off by default.</li><li>Export your library, manage connected apps, or delete your account in Settings.</li></ul>
    </section>
  </main>
  <footer><div class="container footer-inner"><p class="footer-credit"><strong>Drop It</strong><br>Published by ${publisher}.</p><nav aria-label="Product information"><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></div></footer>
</body>
</html>`;
}
