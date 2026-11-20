// Framework-less SPA: swaps the content and the URL with history.pushState,
// without reloading the page. The tracking script counts each route change.
const routes = {
  "/": { title: "SPA: home", body: "SPA home page." },
  "/pricing": { title: "SPA: pricing", body: "Pricing table." },
  "/contact": { title: "SPA: contact", body: "Get in touch with us." },
};

function render() {
  const route = routes[location.pathname] ?? { title: "SPA: not found", body: "Page not found." };
  document.title = route.title;
  document.getElementById("view").textContent = route.body;
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link) return;
  event.preventDefault();
  if (link.pathname === location.pathname) return;
  history.pushState(null, "", link.pathname);
  render();
});

addEventListener("popstate", render);
render();
