#!/bin/bash
# Host watchdog: runs every minute as root from the system launchd domain,
# which, unlike the NanoClaw LaunchAgents, survives a GUI logout.
#
# 1. Console: a WindowServer crash logs the user out, taking down gui/<uid>
#    with the host, Apple Container's services, backup and tailscale-serve.
#    Auto-login only fires at boot, so the Mac sits at the login window until
#    someone logs in (2026-10-29: down 07:15 → 20:05). If the login window has
#    held the console for GRACE seconds, reboot and let auto-login restore it
#    all. At most one watchdog reboot per MIN_REBOOT_GAP, so a broken
#    auto-login cannot become a reboot loop.
# 2. Memory: every SAMPLE_EVERY seconds append one sample to SAMPLES. The
#    2026-10-29 crash followed kernel_task growing to a ~103 GB footprint on a
#    16 GB machine; the samples show whether it creeps up between boots.
#
# Installed as a root-owned copy by scripts/install-host-watchdog.sh, never
# run from the repo by launchd. The env overrides exist for testing only.

set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

STATE_DIR=${NANOCLAW_WATCHDOG_STATE_DIR:-/var/db/nanoclaw-host-watchdog}
LOG_DIR=${NANOCLAW_WATCHDOG_LOG_DIR:-/Library/Logs/NanoClaw}
DRY_RUN=${NANOCLAW_WATCHDOG_DRY_RUN:-0}
LOG=$LOG_DIR/host-watchdog.log
SAMPLES=$LOG_DIR/memory-samples.tsv
GRACE=300
MIN_REBOOT_GAP=21600
SAMPLE_EVERY=900

mkdir -p "$STATE_DIR" "$LOG_DIR"
now=$(date +%s)

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG"; }

# "1026 MB" / "1,5 GB" (the locale may use a decimal comma) → whole MB.
to_mb() {
  awk -v v="${1/,/.}" -v u="$2" 'BEGIN {
    m = (u == "GB") ? v * 1024 : (u == "KB") ? v / 1024 : (u == "B") ? v / 1048576 : v
    printf "%d", m
  }'
}

sample_memory() {
  local last=0
  [ -f "$STATE_DIR/last-sample" ] && last=$(cat "$STATE_DIR/last-sample")
  [ "${1:-}" = force ] || [ $((now - last)) -ge $SAMPLE_EVERY ] || return 0
  echo "$now" >"$STATE_DIR/last-sample"

  local page vm boot
  page=$(sysctl -n hw.pagesize)
  vm=$(vm_stat)
  pages_mb() {
    echo "$vm" | awk -F: -v k="$1" -v p="$page" '$1 == k { gsub(/[ .]/, "", $2); printf "%d", $2 * p / 1048576 }'
  }
  boot=$(sysctl -n kern.boottime | awk '{ gsub(/,/, ""); print $4 }')
  local swap kernel vms
  swap=$(sysctl -n vm.swapusage | awk '{ for (i = 1; i <= NF; i++) if ($i == "used") { v = $(i + 2); sub(/M/, "", v); sub(/,/, ".", v); printf "%d", v } }')
  kernel=$(footprint -p 0 2>/dev/null | awk '/Footprint:/ { for (i = 1; i <= NF; i++) if ($i == "Footprint:") { print $(i + 1), $(i + 2); exit } }')
  # shellcheck disable=SC2086
  kernel=$(to_mb ${kernel:-0 MB})
  vms=$(ps -axo rss=,comm= | awk '/Virtualization\.VirtualMachine/ { n++; s += $1 } END { printf "%d\t%d", n, s / 1024 }')

  [ -f "$SAMPLES" ] || printf 'time\tuptime_h\tconsole\tpressure\tfree_mb\twired_mb\tcompressor_mb\tcompressed_mb\tswap_used_mb\tkernel_task_mb\tvms\tvm_rss_mb\n' >"$SAMPLES"
  printf '%s\t%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" $(((now - boot) / 3600)) \
    "$(stat -f %Su /dev/console)" "$(sysctl -n kern.memorystatus_vm_pressure_level)" \
    "$(pages_mb 'Pages free')" "$(pages_mb 'Pages wired down')" \
    "$(pages_mb 'Pages occupied by compressor')" "$(pages_mb 'Pages stored in compressor')" \
    "${swap:-0}" "$kernel" "$vms" >>"$SAMPLES"
}

# Logs a refusal once per login-window episode instead of every minute.
note_once() {
  [ -f "$STATE_DIR/noted-$1" ] && return 0
  touch "$STATE_DIR/noted-$1"
  log "$2"
}

check_console() {
  local owner since boot
  owner=${NANOCLAW_WATCHDOG_CONSOLE_OWNER:-$(stat -f %Su /dev/console)}
  if [ "$owner" != root ]; then
    if [ -f "$STATE_DIR/login-window-since" ]; then
      log "console back with $owner"
      rm -f "$STATE_DIR/login-window-since" "$STATE_DIR"/noted-*
    fi
    return 0
  fi

  # A marker from before the last boot belongs to an episode the reboot ended.
  boot=$(sysctl -n kern.boottime | awk '{ gsub(/,/, ""); print $4 }')
  since=$(cat "$STATE_DIR/login-window-since" 2>/dev/null || echo 0)
  if [ "$since" -lt "$boot" ]; then
    echo "$now" >"$STATE_DIR/login-window-since"
    rm -f "$STATE_DIR"/noted-*
    log "login window holds the console"
    return 0
  fi
  [ $((now - since)) -ge $GRACE ] || return 0

  # Rebooting only helps if auto-login follows it, and FileVault disables it.
  if [ -z "$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)" ] ||
    ! fdesetup status | grep -q 'FileVault is Off'; then
    note_once autologin "login window for $((now - since))s but auto-login is not available — not rebooting"
    return 0
  fi
  local last
  last=$(cat "$STATE_DIR/last-reboot" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt $MIN_REBOOT_GAP ]; then
    note_once gap "login window for $((now - since))s but the last watchdog reboot was $((now - last))s ago — not rebooting"
    return 0
  fi

  sample_memory force
  log "login window held the console for $((now - since))s — rebooting"
  if [ "$DRY_RUN" = 1 ]; then
    log "dry run: would reboot"
    return 0
  fi
  echo "$now" >"$STATE_DIR/last-reboot"
  shutdown -r now "nanoclaw host-watchdog: login window held the console for $((now - since))s"
}

check_console
sample_memory
