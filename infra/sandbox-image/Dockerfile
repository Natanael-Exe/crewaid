# The bot sandbox image (PRD §5).
#
# One of these runs per computer: a full XFCE desktop the operator watches over RFB
# and drives with real input events. It is deliberately a DESKTOP, not a
# headless browser — the product premise is that you can see what the bot sees.
#
# §5 calls itself "a specification — package names may be adjusted to make the
# build succeed, but every capability must survive". Three adjustments were
# needed; each is noted at the line that makes it.
#
# Build context: THE REPO ROOT, because this image ships code from the
# repository itself — the M3-PK-01 skill executor, bundled from
# packages/skill-runtime into the Node runtime below.
#
#   Built by: docker build -f infra/sandbox-image/Dockerfile -t crewaid/sandbox:dev .
#   Run by:   DockerSandboxProvider (M2-BE-01) under the §5.1 constraints.

# ── The Node runtime and the skill executor (M3-PK-01) ────────────────────────
#
# M3-PK-01 makes `POST /skill/run` execute instead of answering 503, so the
# image needs a JavaScript runtime and a copy of the executor. How the runtime
# is delivered, and why (see infra/sandbox-image/README.md for the full note):
#
#   * The version is the EXACT tag node:22.23.2-bookworm-slim — the same
#     "exact pin, no ranges" rule as M0-07 — and it matches the base OS
#     (bookworm) so the one binary below links against the libraries already
#     present. Nothing is apt-installed: a distro `nodejs` package would be
#     both the wrong major (bookworm ships 18.x) and a floating patch.
#   * Node and npm come from the same pinned stage. Git and native build
#     tools let project bots work on separate branches and install dependencies.
#   * The executor bundle is built from THIS commit's sources in a stage, and
#     the bundler version is read from the repo's own esbuild pin (M0-07)
#     rather than repeated here — a literal in two places drifts, and
#     check-pins only guards the manifests. Native Playwright's code/assets
#     ship beside the ESM bundle; the existing seat owns the Chrome binary.
#   * The executor runs as `bot`, like everything else in this container. The
#     §5.1 limits, cap_drop, no-new-privileges, the network setup and the lack
#     of host mounts are all unchanged — a skill gets exactly the sandbox the
#     operator's own hands would.
FROM node:22.23.2-bookworm-slim AS node-runtime

FROM node-runtime AS skill-bundle
WORKDIR /skill-runtime
COPY apps/desktop/package.json /skill-runtime/desktop-package.json
COPY packages/skill-runtime/package.json /skill-runtime/skill-package.json
COPY packages/skill-runtime/src /skill-runtime/src
RUN ESBUILD_VERSION="$(node -p 'require("./desktop-package.json").devDependencies.esbuild')" \
    && PLAYWRIGHT_VERSION="$(node -p 'require("./skill-package.json").dependencies["playwright-core"]')" \
    && npm install --prefix /playwright-runtime --save-exact --ignore-scripts --package-lock=false "playwright-core@${PLAYWRIGHT_VERSION}" \
    && npx --yes "esbuild@${ESBUILD_VERSION}" src/runner.ts \
         --bundle --platform=node --format=esm --target=node22 --external:playwright-core \
         --outfile=/skill-runtime/runner.mjs

# ── The screen gateway (D-223) ────────────────────────────────────────────────
#
# A computer serves its own screens to viewers that hold a grant, so the pixels
# never cross the orchestrator. One CommonJS file built from THIS commit's
# sources, with its two dependencies (`ws`, `zod`) inside it, pinned from the
# repo's own manifests as the skill runner's are. CommonJS because `ws` loads
# Node's built-ins with `require`, which an ESM bundle cannot do without a shim.
FROM node-runtime AS screen-gateway-bundle
WORKDIR /screen-gateway
COPY apps/desktop/package.json /screen-gateway/desktop-package.json
COPY packages/shared/package.json /screen-gateway/shared-package.json
COPY packages/screen-gateway/package.json /screen-gateway/gateway-package.json
COPY packages/shared/src /screen-gateway/shared/src
COPY packages/screen-stream/src /screen-gateway/screen-stream/src
COPY packages/screen-gateway/src /screen-gateway/gateway/src
RUN ESBUILD_VERSION="$(node -p 'require("./desktop-package.json").devDependencies.esbuild')" \
    && ZOD_VERSION="$(node -p 'require("./shared-package.json").dependencies.zod')" \
    && WS_VERSION="$(node -p 'require("./gateway-package.json").dependencies.ws')" \
    && npm install --save-exact --ignore-scripts --package-lock=false "zod@${ZOD_VERSION}" "ws@${WS_VERSION}" \
    && npx --yes "esbuild@${ESBUILD_VERSION}" gateway/src/main.ts \
         --bundle --platform=node --format=cjs --target=node22 \
         --alias:@crewaid/shared=./shared/src/index.ts \
         --alias:@crewaid/screen-stream=./screen-stream/src/index.ts \
         --external:bufferutil --external:utf-8-validate \
         --outfile=/screen-gateway/gateway.cjs

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    SCREEN_DEPTH=24

# HOME and XDG_RUNTIME_DIR are not implied by `USER bot`. Docker leaves HOME at
# `/` regardless of what useradd wrote in /etc/passwd, and every piece of this
# image reads it: Chrome resolves --user-data-dir against it, xfce4-session
# writes its session cache under it, and dbus and plank both derive paths from
# XDG_RUNTIME_DIR. Left unset, the desktop comes up in a state where each
# component fails differently and none of them says why.
ENV HOME=/home/bot \
    XDG_RUNTIME_DIR=/tmp/runtime-bot \
    XDG_CONFIG_HOME=/home/bot/.config \
    XDG_CACHE_HOME=/home/bot/.cache

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc xfce4-session xfwm4 xfdesktop4 thunar xfce4-terminal \
      plank at-spi2-core dbus-x11 xdotool wmctrl scrot feh \
      # The screen-recording tool path (record_screen_start/stop) encodes with
      # libx264 inside the container, so ffmpeg has to be IN the image: the
      # tools exec it, they do not install it.
      ffmpeg \
      fonts-dejavu-core ca-certificates curl gnupg python3 python3-pyatspi \
    # D-046 / M5-BE-18. A seat pins its window's ICCCM WM_NORMAL_HINTS to
    # min == max, which is what makes the window manager, Chrome and a page's
    # own window.resizeTo all refuse to resize it — and therefore what makes
    # R8 hold per seat on a window-scoped RFB stream. Nothing else in the
    # image can write that property: xdotool and wmctrl only ask for a
    # geometry, and x11-utils' xprop cannot express XSizeHints.
      python3-xlib \
    # Not in §5's list. debian-slim ships no `ps`, and M2-QA-04 has to kill ONE
    # named supervised child to prove the entrypoint's exit contract — without
    # a process table that test can only kill the whole container, which is a
    # different assertion. The bridge's /health reads /proc directly and does
    # not depend on this.
      procps socat git build-essential ripgrep fd-find \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    # §5 hardcodes `arch=amd64` here. Google now publishes google-chrome-stable
    # for linux arm64 as well, so the literal is the only thing that made this
    # image x86-only — on an arm64 host apt would look for amd64 candidates and
    # find none. Reading the architecture from dpkg lets the identical
    # Dockerfile build natively on an Apple Silicon dev machine and on either
    # Hetzner server line, with no QEMU in the loop.
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] \
       http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Suppress Chrome auto-update nags, relaunch badges, and promotional prompts
# inside the unprivileged container; browser upgrades arrive with image builds.
RUN mkdir -p /etc/opt/chrome/policies/managed \
    && printf '%s\n' \
         '{' \
         '  "ComponentUpdatesEnabled": false,' \
         '  "RelaunchNotification": 0,' \
         '  "SuppressUnsupportedOSWarning": true,' \
         '  "DefaultBrowserSettingEnabled": false,' \
         '  "PromotionalTabsEnabled": false,' \
         '  "BrowserSignin": 0,' \
         '  "MetricsReportingEnabled": false,' \
         '  "BackgroundModeEnabled": false' \
         '}' > /etc/opt/chrome/policies/managed/crewaid.json \
    && chmod 644 /etc/opt/chrome/policies/managed/crewaid.json

RUN useradd -m -s /bin/bash bot

# XDG_RUNTIME_DIR must exist, be 0700, and be owned by the user before the
# session starts; nothing in the image creates it lazily. /tmp/.ICE-unix and
# /tmp/.X11-unix are the same story one layer down: their clients and servers
# try to create them after the container has dropped to `bot`, but X11 socket
# directories must be root-owned and mode 1777. Without the explicit X11
# directory Xvfb can expose only Linux's abstract socket; some clients connect
# while others make xfce4-session exit, so the same image boots nondeterministically.
RUN mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.chrome" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" \
      /tmp/.ICE-unix /tmp/.X11-unix \
    && chown -R bot:bot "$XDG_RUNTIME_DIR" "$HOME" \
    && chmod 700 "$XDG_RUNTIME_DIR" \
    && chmod 1777 /tmp/.ICE-unix /tmp/.X11-unix

# The dock's contents are an acceptance criterion, not decoration: §5 requires
# the screen panel to show Chrome, Thunar, and a terminal in the dock, and
# M2-QA's image smoke test needs that to be a deterministic assertion rather
# than "whatever happened to be running when the screenshot fired". Left
# unseeded, plank writes its own launchers for whatever it observes — on the
# first boot here that produced two duplicate Chrome entries and no file
# manager or terminal at all.
#
# Chrome ships TWO desktop entries — google-chrome.desktop and
# com.google.Chrome.desktop — carrying the identical StartupWMClass. Plank
# resolves the running browser to the first, so pinning the second leaves the
# live window unmatched and the dock shows Chrome twice. (The entrypoint's
# --class flag is the other half of that fix; neither works alone.) The numeric
# prefixes are for reading order in this directory only — plank keeps its own
# left-to-right ordering and does not take it from the filenames.
#
# ── WHY THIS LIVES IN /opt/crewaid/skel AND NOT IN /home/bot (D-039) ────────────
#
# A bot's durable workspace is a named volume mounted at /home/bot. Docker
# populates such a volume from the image ONLY while the volume is empty; after
# that the image's copy of anything under that path is invisible and frozen.
# Measured: deleting /home/bot/.config/plank from a populated volume and
# re-running the same image left it deleted.
#
# So config seeded directly into /home/bot would be config every bot keeps
# forever at whatever its first boot wrote — and the dock is an ACCEPTANCE
# CRITERION (§5), not decoration. The pristine copy therefore lives outside the
# mount point, and entrypoint.sh copies it over $HOME on every boot. Whatever
# is in this directory is image-owned and is replaced on every start; anything
# a bot must keep (its files, .chrome) must never appear here.
RUN mkdir -p /opt/crewaid/skel/.config/plank/dock1/launchers \
    && for entry in 00:google-chrome 01:thunar 02:xfce4-terminal; do \
         printf '[PlankDockItemPreferences]\nLauncher=file:///usr/share/applications/%s.desktop\n' \
           "${entry#*:}" > "/opt/crewaid/skel/.config/plank/dock1/launchers/${entry%%:*}-${entry#*:}.dockitem"; \
       done \
    && chown -R bot:bot /opt/crewaid

# A seat starts with only a root window, window manager and dock. Without an
# explicit root pixmap X renders that desktop black until an application fills
# it. Keep the wallpaper image-owned so every existing workspace receives UI
# improvements after an image update, just like the dock configuration above.
COPY infra/sandbox-image/assets/crewaid-sky-wallpaper.png /opt/crewaid/wallpapers/crewaid-sky-wallpaper.png
RUN chown -R bot:bot /opt/crewaid/wallpapers

# The dock's Chrome icon must open THIS seat's browser, not a bare Chrome.
#
# The stock desktop entry runs `/usr/bin/google-chrome-stable` with none of the
# flags a seat's browser is started with: no --no-sandbox where the container
# cannot give Chrome its own sandbox (D-145) — fatal before a window appears,
# which is the icon that did nothing however many times it was clicked under
# D-027 — and no per-seat --user-data-dir or CDP
# relay, so even a surviving launch would open a browser the bot cannot drive
# and nothing can record. The Exec lines below are pointed at the launcher
# that asks the agent bridge instead: the same start a browser tool call
# makes, idempotent, capacity-checked, addressed by the DISPLAY plank hands it.
#
# The stock file is edited in place rather than overridden, because the
# dockitem pins `file:///usr/share/applications/google-chrome.desktop` by path
# and plank pairs the running window with the pinned launcher through THAT
# file's StartupWMClass — a second entry carrying the same class is what showed
# Chrome twice before this comment existed. The grep fails the build if Google
# renames the Exec line, rather than shipping an icon that silently launches a
# bare Chrome again.
RUN grep -q '^Exec=/usr/bin/google-chrome-stable' /usr/share/applications/google-chrome.desktop \
    && sed -i 's|^Exec=/usr/bin/google-chrome-stable|Exec=/opt/crewaid/open-seat-browser|' \
       /usr/share/applications/google-chrome.desktop

# The runtime the skill runner needs, and the runner itself. /opt is
# image-owned: root-owned and mode 755 by default, so `bot` can read and
# execute the bundle and nothing in a running sandbox can rewrite it.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=skill-bundle /skill-runtime/runner.mjs /opt/skill-runtime/runner.mjs
COPY --from=skill-bundle /playwright-runtime/node_modules/playwright-core /opt/skill-runtime/node_modules/playwright-core
COPY --from=screen-gateway-bundle /screen-gateway/gateway.cjs /opt/screen-gateway/gateway.cjs

WORKDIR /home/bot
COPY infra/sandbox-image/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY infra/sandbox-image/agent-bridge/bridge.py /opt/agent-bridge/bridge.py
COPY infra/sandbox-image/agent-bridge/seat_control.py /opt/agent-bridge/seat_control.py
COPY infra/sandbox-image/agent-bridge/seats.py /opt/agent-bridge/seats.py
COPY infra/sandbox-image/agent-bridge/exec_stream.py /opt/agent-bridge/exec_stream.py
COPY infra/sandbox-image/agent-bridge/git_helper.py /opt/agent-bridge/git_helper.py
COPY infra/sandbox-image/agent-bridge/profiles.py /opt/agent-bridge/profiles.py
COPY infra/sandbox-image/agent-bridge/screen_key.py /opt/agent-bridge/screen_key.py
COPY infra/sandbox-image/close-browser.py /opt/crewaid/close-browser.py
COPY infra/sandbox-image/open-seat-browser /opt/crewaid/open-seat-browser
COPY infra/sandbox-image/crewaid-desktop-up /usr/local/bin/crewaid-desktop-up
# Runtime's start command and the home it keeps across image switches (D-219).
COPY infra/sandbox-image/crewaid-runtime-start /usr/local/bin/crewaid-runtime-start
COPY infra/sandbox-image/crewaid-home-on-workspace /usr/local/bin/crewaid-home-on-workspace
RUN chmod +x /usr/local/bin/entrypoint.sh /opt/crewaid/open-seat-browser /usr/local/bin/crewaid-desktop-up \
      /usr/local/bin/crewaid-runtime-start /usr/local/bin/crewaid-home-on-workspace

USER bot
# 5900 x11vnc (RFB) · 9222 Chrome CDP · 7070 agent-bridge · 5901-5916 seats.
# Each seat has a whole-display RFB stream and CDP relay, so the
# per-seat ports are declared here even though which of them a machine uses is
# decided at runtime by how many bots sit on it.
#
# Sixteen is a port ceiling, not a resource guarantee. The bridge checks PID
# and memory headroom before opening another profile (WORKSPACE §20).
# The machine's three (5900, 9222, 7070) are resolved by the orchestrator
# through getPortEndpoint (D-012); nothing outside DockerSandboxProvider may
# assume a mapping for any of them.
#
# The screen gateway's 7071 is deliberately not here: it listens on loopback
# only, and is reached through a provider's authenticated preview (D-223).
EXPOSE 5900 5901-5916 9301-9316 9222 7070
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
