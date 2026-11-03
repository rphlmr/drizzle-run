async function mountPlaygrounds() {
  const parameters = new URLSearchParams(window.location.search);
  const targets = [
    ...parameters.getAll("snapshotId").map((snapshotId) => ({ snapshotId })),
    ...parameters.getAll("example").map((value) => {
      const [example, step] = value.split("/");
      return step === undefined ? { example } : { example, step };
    }),
  ];
  const baseUrl = parameters.get("baseUrl");
  const previews = parameters.getAll("preview");
  const root = document.querySelector("#playgrounds");
  const mounts = [];

  if (baseUrl === null || targets.length === 0) {
    root.textContent = "Fixture configuration is missing a snapshot ID or example, or the Drizzle Run base URL.";
    document.documentElement.dataset.fixtureReady = "true";
    return;
  }

  const loaderUrl =
    parameters.get("hostedLoader") === "true"
      ? new URL("/embed/index.js", baseUrl)
      : new URL("/embed/index.js", window.location.origin);
  const { mountPlayground } = await import(loaderUrl.href);

  for (const [index, target] of targets.entries()) {
    const section = document.createElement("section");
    const title = document.createElement("h2");
    title.textContent = `Shared playground ${index + 1}`;
    const mountPoint = document.createElement("div");
    mountPoint.dataset.playgroundMount = String(index);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = `Remove playground ${index + 1}`;
    remove.addEventListener("click", () => {
      mounts[index]?.dispose();
      section.remove();
    });
    section.append(title, mountPoint, remove);
    root.append(section);
    const preview = JSON.parse(previews[index]);
    mounts[index] = mountPlayground(mountPoint, { ...target, baseUrl, preview });
  }

  document.documentElement.dataset.fixtureReady = "true";
}

void mountPlaygrounds();
