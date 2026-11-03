// eve declares every framework it can plug into as an optional peer, and pnpm links an optional
// peer whenever the workspace has it: `site` has next and react, the factory's vitest has vite,
// so eve (and with it the stage image) got next with swc, react and vite (~330 MB) that the factory
// never loads. The factory uses eve's server, its client and `eve build`, none of which import
// them; dropping these peers keeps them out of eve's dependency set. site keeps its own next.
const UNUSED_EVE_PEERS = ["next", "react", "vite"];

function readPackage(pkg) {
  if (pkg.name === "eve") {
    for (const peer of UNUSED_EVE_PEERS) {
      if (pkg.peerDependencies) delete pkg.peerDependencies[peer];
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[peer];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
