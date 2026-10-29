// Marketing home page, ported verbatim from turnip-ios site/index.html:
// same copy, same structure, same class names. Only the links changed
// from file names (index.html, support.html, privacy.html) to routes.
export function Home() {
  return (
    <main>
      <section className="hero">
        <div className="wrap">
          <img className="icon" src="/assets/icon-512.png" alt="" />
          <h1>Turn tricking footage into clips worth posting.</h1>
          <p className="tagline">
            Turnip scans your tricking footage, trims the dead time, crops to
            you, and drops one clip per trick straight into Photos —
            entirely on-device.
          </p>
          <div className="badge-row">
            <span className="pill-note">Coming soon to the App Store</span>
            <a className="btn btn-ghost" href="https://github.com/hoiekim/turnip-ios">
              View source on GitHub
            </a>
          </div>
        </div>
      </section>

      <section className="features">
        <div className="wrap">
          <h2 className="section-title">How it works</h2>
          <p className="section-lead">
            Film a session with Turnip&apos;s own camera, or pick any video already
            in your Photos library. Turnip does the rest.
          </p>
          <div className="feature-grid">
            <div className="feature">
              <h3>Finds every trick</h3>
              <p>
                On-device pose detection scans the footage and finds every
                span of athletic motion — no manual scrubbing through dead time.
              </p>
            </div>
            <div className="feature">
              <h3>Trims the wait</h3>
              <p>
                Each clip is trimmed to the trick itself, with just enough
                buffer before and after that landings aren&apos;t cut short.
              </p>
            </div>
            <div className="feature">
              <h3>Crops to the athlete</h3>
              <p>
                Every clip is auto-cropped to follow you through the trick,
                framed for Reels, TikTok, and Shorts.
              </p>
            </div>
            <div className="feature">
              <h3>Ready to share</h3>
              <p>
                Preview, keep or discard, fine-tune the trim and crop by hand,
                then export straight to Photos with a share action on each clip.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="privacy">
        <div className="wrap">
          <h2 className="section-title">Private by design</h2>
          <p className="section-lead">Turnip processes everything on your phone.</p>
          <div className="privacy-card">
            <ul>
              <li>No accounts, no sign-in, no analytics.</li>
              <li>Your videos never leave your phone — there&apos;s no server in the loop.</li>
              <li>Photos access is used only to show your videos and save the clips you export.</li>
              <li>Camera and microphone access are requested only if you record inside the app.</li>
            </ul>
          </div>
          <p className="section-link">
            <a href="/privacy">Read the full privacy policy →</a>
          </p>
        </div>
      </section>
    </main>
  );
}
