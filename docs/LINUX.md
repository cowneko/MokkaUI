# Installing on Linux

MokkaUI ships for x86_64 Linux as an AppImage, a `.deb` and an `.rpm` on every
[release](https://github.com/cowneko/MokkaUI/releases).

| Distro | Install | Update |
| --- | --- | --- |
| Arch, Manjaro, EndeavourOS | [AUR](#arch-aur): `yay -S mokkaui-bin` | `yay -Syu` |
| Debian, Ubuntu, Mint, Pop!_OS | [the release `.deb`](#debian-and-ubuntu) | install a newer `.deb`, or use the in-app updater |
| Fedora, RHEL clones | [the release `.rpm`](#fedora) | install a newer `.rpm`, or use the in-app updater |
| Anything else | download the `.AppImage`, `chmod +x` it and run it | in-app updater |

This fork does not run a package-repository server, so there is no apt or dnf
URL to add: you install the file from the releases page. The release job still
builds signed repository metadata (`apt-InRelease`, `rpm-repomd.xml.asc` and
friends) for anyone who wants to host one — see
[`packaging/linux/README.md`](../packaging/linux/README.md).

When a package manager owns the install, MokkaUI's update banner shows your
system's update command instead of downloading the update itself.

All routes install only the app. On first launch the setup wizard downloads
Python, PyTorch and ComfyUI into your data folder
(`~/.local/share/com.mokkaui.desktop` unless you pick another), the same as on
Windows. Removing the package leaves that folder and your models in place.
Setup needs `git`; the packages pull it in.

## Arch (AUR)

The recipe is
[`packaging/aur/mokkaui-bin/PKGBUILD.in`](../packaging/aur/mokkaui-bin/PKGBUILD.in)
in this repository. The release job renders it with the new version and hash and
pushes it to the AUR, so what an AUR helper fetches is generated from that
template:

```bash
yay -S mokkaui-bin    # or: paru -S mokkaui-bin
```

`mokkaui-bin` repackages the release `.deb`. It deliberately neither provides
nor conflicts with `mooshieui` or `mooshie-ui`: those names belong to the
upstream project this fork came from, and claiming them would let pacman swap or
remove an unrelated upstream install that ships different files.

If your helper answers that no such package exists, the AUR registration has not
happened yet — the name has to be registered on aur.archlinux.org once before
the release job can push to it. Use the AppImage in the meantime.

## Debian and Ubuntu

Ubuntu 22.04 or newer, Debian 12 or newer (the app needs WebKitGTK 4.1). Pick
the `.deb` of the release you want and install it by path, so apt resolves the
dependencies from the mirrors you already configured:

```bash
sudo apt install ./MokkaUI_<version>_amd64.deb
```

To update, install the newer `.deb`. To remove it:

```bash
sudo apt remove "$(dpkg -f MokkaUI_<version>_amd64.deb Package)"
```

That subshell is not decoration: the bundler derives the deb package name from
the product name, so read it off the file instead of guessing at its spelling.

## Fedora

```bash
sudo dnf install ./MokkaUI-<version>-1.x86_64.rpm
```

To remove it:

```bash
sudo dnf remove "$(rpm -qp --qf '%{NAME}' MokkaUI-<version>-1.x86_64.rpm)"
```

## Signatures, and which key is ours

Automatic updates are verified against the updater public key compiled into the
app (`bundle.createUpdaterArtifacts` and its `pubkey` in
[`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json)); every release
carries the matching `.sig` asset.

The repository-metadata signing key belongs to this fork as well, and its
fingerprint is deliberately not pinned in the tree: it is whatever key the
`REPO_GPG_PRIVATE_KEY` repository secret holds, and the release job prints it in
its log. Publish and distribute the public half as described in
[`packaging/linux/README.md`](../packaging/linux/README.md).

One thing worth checking if you find instructions somewhere else: the key
`1F82 986C 6CC1 D890 5E48  FE0D FF29 34B6 0954 B5D7`, uid
`MooshieUI Packages <blob@mooshieblob.com>`, is the **upstream** project's key.
Nothing published from this repository is signed by it, so metadata signed by
that key is not this fork.

## Uninstalling

Remove the package (`sudo apt remove …` and `sudo dnf remove …` above, or
`yay -R mokkaui-bin`), plus any repository file and key you added by hand.
Delete `~/.local/share/com.mokkaui.desktop` too if you want the runtime and
models gone.

## Flatpak

There is no Flatpak yet. The first-run install of Python, PyTorch and ComfyUI
does not fit the Flatpak sandbox well (GPU access in particular), so the
AppImage is the distro-independent option for now.
