# Third-party notices

HomeAgent's original source is released under the MIT License in [LICENSE](LICENSE).
Dependency packages, container base images, Git, Node.js and optional deployment
tools retain their own licenses. The HomeAgent license does not replace them.

## Runtime npm dependencies

The complete inventory for the locked production dependency tree, with the license
and notice files distributed in the installed packages, is generated in
[licenses/npm-runtime.txt](licenses/npm-runtime.txt).

```sh
npm ci
npm run notices
npm run notices:check
```

The generator includes transitive production packages and preserves the supplied
license/notice text. Development-only packages are not redistributed in the
production Docker image; their license metadata and files remain in the installed
packages. A modified dependency tree requires regenerating the inventory.

The Docker image contains the HomeAgent license, this notice and the runtime
inventory. Node.js, the Debian base system and packages installed by apt retain
their license files in the image. Caddy and cloudflared are optional separate
images and are distributed under their respective upstream terms.

## Design references

- WebCodex, `yyjeqhc/webcodex`, is a reference for Server/Runner separation,
  project authorization and observable development jobs.
- Better Remote Commander, `shahidx0x/better-remote-commander`, is a reference for
  outbound agents, pairing, a lightweight relay and practical file/process tools.
- Desktop Commander is a reference for tool naming and common file/terminal
  workflows.

These are design acknowledgements. Their source repositories and binaries are not
vendored or redistributed in this repository. The comparison inventory records
tool identifiers, source locations and our own descriptions, rather than including
their implementations. See [the comparison](docs/COMPARISON.md) and
[source audit](docs/WEBCODEX_CODE_AUDIT.md) for pinned revisions.

HomeAgent is an independent project and does not imply endorsement by those
projects or by any AI client vendor.
