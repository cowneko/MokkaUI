#!/usr/bin/env bash
# End-to-end check of scripts/linux-repo.sh against a published release, with
# a throwaway signing key: apt (on this Ubuntu host) and dnf (in a Fedora
# container) must both accept the signed metadata and resolve this project's
# package. Needs a *published* release of this repository, because it downloads
# the real .deb and .rpm assets by tag. Run by the Linux repo check workflow.
#
#   scripts/linux-repo-check.sh <tag>
set -euo pipefail

tag="${1:?usage: linux-repo-check.sh <tag>}"
version="${tag#v}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'kill "${server:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
repo="${GITHUB_REPOSITORY:-cowneko/MokkaUI}"
base="https://github.com/${repo}/releases/download/${tag}"
deb="MokkaUI_${version}_amd64.deb"
rpm="MokkaUI-${version}-1.x86_64.rpm"

mkdir -p "$work/release"
curl -fsSL --retry 3 -o "$work/release/$deb" "$base/$deb"
curl -fsSL --retry 3 -o "$work/release/$rpm" "$base/$rpm"

export GNUPGHOME="$work/gnupg"
install -d -m 700 "$GNUPGHOME"
gpg --batch --quiet --passphrase '' --quick-gen-key "MokkaUI repo check <check@invalid>" rsa3072 sign never
fpr=$(gpg --batch --with-colons --list-keys | awk -F: '/^fpr/{print $10; exit}')
gpg --batch --armor --export "$fpr" > "$work/key.asc"
MOOSHIEUI_REPO_KEY="$fpr" bash "$root/scripts/linux-repo.sh" "$tag" "$work/release/$deb" "$work/release/$rpm" "$work/assets"

# Lay the flat release assets out the way a real repo server presents them.
site="$work/site"
mkdir -p "$site/apt/dists/stable/main/binary-amd64" "$site/apt/pool/$tag" "$site/rpm/repodata"
for f in InRelease Release Release.gpg; do cp "$work/assets/apt-$f" "$site/apt/dists/stable/$f"; done
for f in Packages Packages.gz; do cp "$work/assets/apt-$f" "$site/apt/dists/stable/main/binary-amd64/$f"; done
cp "$work/release/$deb" "$site/apt/pool/$tag/"
for f in "$work"/assets/rpm-*; do cp "$f" "$site/rpm/repodata/$(basename "$f" | sed 's/^rpm-//')"; done
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$site" >/dev/null 2>&1 &
server=$!
sleep 1

echo "--- apt"
cat > "$work/mokkaui.sources" <<SRC
Types: deb
URIs: http://127.0.0.1:8765/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: $work/key.asc
SRC
mkdir -p "$work/apt-lists/partial" "$work/apt-cache/archives/partial"
apt_opts=(-o "Dir::Etc::SourceList=$work/mokkaui.sources" -o Dir::Etc::SourceParts=/dev/null
  -o "Dir::State::Lists=$work/apt-lists" -o "Dir::Cache=$work/apt-cache" -o Debug::NoLocking=1
  -o APT::Sandbox::User=root)
sudo apt-get "${apt_opts[@]}" update
# Only this repo is configured, so check the candidate rather than a full
# install, whose dependencies come from the distro's own repos.
# The deb control Package: name is stamped by the bundler from productName, so
# read it off the artifact instead of guessing at its camel-casing.
deb_pkg="$(dpkg-deb -f "$work/release/$deb" Package)"
echo "deb package name: $deb_pkg"
apt-cache "${apt_opts[@]}" policy "$deb_pkg" | grep "Candidate: ${version}"
(cd "$work" && sudo apt-get "${apt_opts[@]}" download "$deb_pkg")
cmp "$work"/"${deb_pkg}"_*_amd64.deb "$work/release/$deb"

echo "--- dnf"
cat > "$work/mokkaui.repo" <<REPO
[mokkaui]
name=MokkaUI
baseurl=http://127.0.0.1:8765/rpm
enabled=1
gpgcheck=0
repo_gpgcheck=1
gpgkey=file:///check/key.asc
REPO
# The rpm file name lives on the host, so it crosses into the container as -e RPM:
# a bare $rpm inside this single-quoted script would expand to nothing there.
# --qf is in double quotes for the same reason a ' would be fatal: an apostrophe
# here closes the very script -c is being handed, and bash -n on the outer file
# cannot see it.
docker run --rm --network host -e RPM="$rpm" -v "$work:/check:ro" fedora:latest bash -euo pipefail -c '
  cp /check/mokkaui.repo /etc/yum.repos.d/
  dnf -y -q --disablerepo="*" --enablerepo=mokkaui makecache
  # The rpm Name is stamped by the bundler too, so ask the artifact for it.
  rpm_pkg="$(rpm -qp --qf "%{NAME}" "/check/release/$RPM")"
  dnf -y --disablerepo="*" --enablerepo=mokkaui download --destdir /tmp "$rpm_pkg"
  # fedora:latest has no cmp; compare hashes instead.
  [ "$(sha256sum < /tmp/${rpm_pkg}-*.rpm)" = "$(sha256sum < "/check/release/$RPM")" ]
'
echo "apt and dnf both accepted the signed repo for $tag"
