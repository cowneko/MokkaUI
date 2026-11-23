# Linux package repository

`scripts/linux-repo.sh` builds signed apt and rpm metadata for each stable
release (the `linux-repo` job in `.github/workflows/release.yml`). MokkaUI has
no project website: everything ships from the GitHub Release,
`https://github.com/cowneko/MokkaUI/releases`.

| Channel | Where it lives |
| --- | --- |
| Direct download | `.../releases/download/<tag>/MokkaUI_<version>_amd64.deb`, `MokkaUI-<version>-1.x86_64.rpm`, `MokkaUI_<version>_amd64.AppImage` |
| apt / rpm metadata | the `apt-*` and `rpm-*` assets of the same release |
| Arch / AUR | `mokkaui-bin`, built from `packaging/aur/mokkaui-bin/PKGBUILD.in` |
| In-app updater | `.../releases/latest/download/latest.json` |

## Serving the apt / rpm metadata

A GitHub Release can only hold flat files, so the job names each one after what
it is. A real repository root wants these paths instead:

| Release asset | Path an apt/dnf client expects |
| --- | --- |
| `apt-InRelease`, `apt-Release`, `apt-Release.gpg` | `dists/stable/InRelease`, `dists/stable/Release`, `dists/stable/Release.gpg` |
| `apt-Packages`, `apt-Packages.gz` | `dists/stable/main/binary-amd64/Packages`, `…/Packages.gz` |
| `rpm-repomd.xml`, `rpm-repomd.xml.asc` | `repodata/repomd.xml`, `repodata/repomd.xml.asc` |
| `rpm-primary.xml.gz`, `rpm-filelists.xml.gz`, `rpm-other.xml.gz` | `repodata/primary.xml.gz`, `repodata/filelists.xml.gz`, `repodata/other.xml.gz` |

`apt` and `dnf` therefore cannot be pointed at the release page directly:
either mirror the assets to some host under the paths above, or send users to
the `.deb` / `.rpm` / AppImage, the AUR package, and the in-app updater.

The download side is already correct: the rpm repodata `baseurl` is built from
the repository the workflow runs in (`MOOSHIEUI_GITHUB_REPO`, passed as
`github.repository`), i.e. `https://github.com/cowneko/MokkaUI/releases/download/<tag>/`,
so packages resolve to this release's own assets — not to upstream's — the
moment a client can read the repodata. The apt `Packages` entries use
`Filename: pool/<tag>/<file>.deb`, relative to whatever serves that tree.

## Signing key

The signing key is simply whatever `REPO_GPG_PRIVATE_KEY` holds
(`REPO_GPG_PASSPHRASE`, if it is passphrase-protected, unlocks it). The release
job imports it into a throwaway `GNUPGHOME`, reads the primary fingerprint back
out of the imported secret key, and passes it to `linux-repo.sh` as
`MOOSHIEUI_REPO_KEY`. The fingerprint it used is printed in the
`Build and sign repo metadata` step log.

No public key is committed here any more. `packaging/linux/mooshieui.asc` used
to sit in this folder and the job refused to sign anything that was not its
private half — but that key is **upstream** MooshieUI's (fingerprint
`1F82986C6CC1D8905E48FE0DFF2934B60954B5D7`, uid `MooshieUI Packages
<blob@mooshieblob.com>`), so MokkaUI could never sign its own repository.
Do not re-add it, and do not point users at `mooshieui.com`.

Publish the public half of your own key next to the install instructions
instead, for example as a `mokkaui.asc` release asset:

```sh
gpg --export --armor '<fingerprint-from-the-release-log>' > mokkaui.asc
```

`apt` needs it for `Signed-By` in the `.sources` file; dnf/zypper need it as
`gpgkey=` for `gpgcheck` / `repo_gpgcheck`.

## Filenames the installed app looks for

`src-tauri/src/package_manager.rs` decides whether the system package manager
owns the install by looking for `/etc/apt/sources.list.d/mooshieui.sources`,
`/etc/yum.repos.d/mooshieui.repo`, `/etc/zypp/repos.d/mooshieui.repo`, and the
`/usr/share/mooshieui/package-manager` marker that the AUR package writes. Those
constants are still upstream-branded and owned by the Rust side, so repo
instructions and `packaging/aur/mokkaui-bin/PKGBUILD.in` have to keep using
exactly those paths until that file is renamed — rename both sides in one
commit, or MokkaUI will offer its in-app updater on top of a package-managed
install.
