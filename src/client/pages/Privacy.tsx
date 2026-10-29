// Privacy page, ported verbatim from turnip-ios site/privacy.html: same
// copy, same structure, same class names. Only the links changed from
// file names to routes.
//
// Note: this page describes the shipped v1 app (fully on-device), as
// does the source — see turnip-ios docs/PRIVACY.md. Its "no servers in
// the loop / never uploads anything" wording predates the farm's
// opt-in contribution flow; the wording update belongs in turnip-ios
// (PRIVACY.md + site/privacy.html) and re-ports here. Do not edit the
// claims in this file alone.
export function Privacy() {
  return (
    <main className="page">
      <div className="wrap">
        <h1>Privacy Policy</h1>
        <p className="lead">
          Last updated September 22, 2026. Short version: Turnip doesn&apos;t collect your data.
        </p>

        <div className="faq">
          <div className="faq-item">
            <h3>What Turnip collects</h3>
            <p>
              Nothing. Turnip has no accounts, no sign-in, and no analytics.
              There are no Turnip servers in the loop — the app doesn&apos;t send
              your videos, clips, or any other data anywhere.
            </p>
          </div>

          <div className="faq-item">
            <h3>Photos access</h3>
            <p>
              Turnip&apos;s video library is your Photos library, so it asks for
              Photos access to show you your videos and to save the clips it
              exports. That access is used only on your device, to read the
              video you pick and write the clips you create.
            </p>
          </div>

          <div className="faq-item">
            <h3>Camera and microphone access</h3>
            <p>
              Requested only if you record a video inside the app instead of
              picking an existing one. The recording is saved straight to your
              Photos library, the same as any video shot with the built-in
              Camera app, and is never sent anywhere else.
            </p>
          </div>

          <div className="faq-item">
            <h3>How your videos are processed</h3>
            <p>
              Trick detection and cropping run entirely on your phone, using a
              bundled on-device model. Nothing about the video — or the fact
              that you used the app — leaves the device during that process.
            </p>
          </div>

          <div className="faq-item">
            <h3>Third parties</h3>
            <p>
              Turnip uses no third-party analytics or advertising SDKs. The
              only bundled dependency is an on-device machine-learning
              library used for pose detection; it doesn&apos;t transmit data
              anywhere.
            </p>
          </div>

          <div className="faq-item">
            <h3>Children&apos;s privacy</h3>
            <p>
              Because Turnip collects no data from anyone, it collects no
              data from children either.
            </p>
          </div>

          <div className="faq-item">
            <h3>Future versions</h3>
            <p>
              A future version of Turnip is expected to add an optional,
              explicit opt-in for uploading clips to a community feature.
              That version will ship its own update to this policy before any
              upload happens — today&apos;s app never uploads anything.
            </p>
          </div>

          <div className="faq-item">
            <h3>Questions</h3>
            <p>
              Reach out any time — see the <a href="/support">support page</a>{" "}
              for contact options. The full technical breakdown behind this
              summary is kept up to date in the{" "}
              <a href="https://github.com/hoiekim/turnip-ios/blob/main/docs/PRIVACY.md">
                source repo
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
