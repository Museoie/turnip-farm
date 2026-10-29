// Support page, ported verbatim from turnip-ios site/support.html: same
// copy, same structure, same class names. Only the links changed from
// file names to routes.
export function Support() {
  return (
    <main className="page">
      <div className="wrap">
        <h1>Support</h1>
        <p className="lead">
          Questions, bug reports, or feedback about Turnip — here&apos;s how to
          reach us.
        </p>

        <div className="contact-grid">
          <div className="contact-card">
            <h3>Email</h3>
            <p>For account, App Store, or general questions.</p>
            <a href="mailto:turnip@hoie.kim">turnip@hoie.kim</a>
          </div>
          <div className="contact-card">
            <h3>Report a bug</h3>
            <p>Found something broken? File it on GitHub.</p>
            <a href="https://github.com/hoiekim/turnip-ios/issues/new">Open an issue</a>
          </div>
        </div>

        <div className="faq">
          <h2>Frequently asked questions</h2>

          <div className="faq-item">
            <h3>Why does Turnip need Photos access?</h3>
            <p>
              Turnip&apos;s Home screen is your video library, so it needs Photos
              access to list your videos and to save the clips it exports.
              Turnip never uploads anything — access is used only on your
              device.
            </p>
          </div>

          <div className="faq-item">
            <h3>Why does Turnip need camera and microphone access?</h3>
            <p>
              Only if you record inside the app instead of picking an existing
              video. A finished recording is saved straight to your Photos
              library, the same as any video you shot with the Camera app.
            </p>
          </div>

          <div className="faq-item">
            <h3>Does Turnip send my videos anywhere?</h3>
            <p>
              No. Detection and cropping run entirely on your phone. There are
              no accounts, no uploads, and no analytics. See the{" "}
              <a href="https://github.com/hoiekim/turnip-ios/blob/main/docs/PRIVACY.md">
                privacy notes
              </a>{" "}
              in the repo for the full breakdown.
            </p>
          </div>

          <div className="faq-item">
            <h3>Turnip didn&apos;t find any tricks in my video. Why?</h3>
            <p>
              Detection looks for spans of clear athletic motion. Very short,
              very still, or heavily obstructed footage can come back with no
              clips. Try a recording with the athlete clearly in frame for the
              whole trick.
            </p>
          </div>

          <div className="faq-item">
            <h3>What devices does Turnip support?</h3>
            <p>
              iPhone running iOS 16 or later. Turnip is iPhone-only and
              portrait-only in the current release.
            </p>
          </div>

          <div className="faq-item">
            <h3>Is Turnip open source?</h3>
            <p>
              Yes — the app is developed in the open at{" "}
              <a href="https://github.com/hoiekim/turnip-ios">
                github.com/hoiekim/turnip-ios
              </a>{" "}
              under the Apache 2.0 license. Bug reports and contributions are
              welcome there.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
