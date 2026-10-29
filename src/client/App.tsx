import { Home } from "./pages/Home";
import { Privacy } from "./pages/Privacy";
import { StatusPage } from "./pages/Status";
import { Support } from "./pages/Support";

// Site shell (header/footer, ported from turnip-ios site/) plus a minimal
// pathname router. Navigation is plain links, so every navigation is a
// fresh load and the route is read once from the URL. The server serves
// the shell for every non-API path (SPA fallback) and Vite's dev server
// does the same, so deep links work. Trailing slashes and .html suffixes
// normalize to the route, so the old site file names keep working.
function currentRoute(): string {
  let path = window.location.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path.endsWith(".html")) path = path.slice(0, -".html".length) || "/";
  if (path === "/index") path = "/";
  return path;
}

function NotFound() {
  return (
    <main className="page">
      <div className="wrap">
        <h1>Page not found</h1>
        <p className="lead">That page doesn&apos;t exist. Try one of these:</p>
        <ul>
          <li>
            <a href="/">Home</a>
          </li>
          <li>
            <a href="/status">Farm status</a>
          </li>
          <li>
            <a href="/support">Support</a>
          </li>
          <li>
            <a href="/privacy">Privacy</a>
          </li>
        </ul>
      </div>
    </main>
  );
}

export function App() {
  const route = currentRoute();
  return (
    <>
      <header className="site">
        <div className="wrap">
          <a className="logo-link" href="/" aria-label="Turnip home">
            <img src="/assets/wordmark.png" alt="Turnip" />
          </a>
          <nav className="site">
            <a href="/status">Status</a>
            <a href="/support">Support</a>
            <a href="/privacy">Privacy</a>
            <a href="https://github.com/hoiekim/turnip-ios">GitHub</a>
          </nav>
        </div>
      </header>

      {route === "/" ? (
        <Home />
      ) : route === "/status" ? (
        <StatusPage />
      ) : route === "/support" ? (
        <Support />
      ) : route === "/privacy" ? (
        <Privacy />
      ) : (
        <NotFound />
      )}

      <footer className="site">
        <div className="wrap">
          <p>&copy; 2026 Hoie Kim</p>
          <nav className="links">
            <a href="/">Home</a>
            <a href="/status">Status</a>
            <a href="/support">Support</a>
            <a href="/privacy">Privacy</a>
            <a href="https://github.com/hoiekim/turnip-ios">GitHub</a>
            <a href="https://github.com/hoiekim/turnip-ios/blob/main/LICENSE">License</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
