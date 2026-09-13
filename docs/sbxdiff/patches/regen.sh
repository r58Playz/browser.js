#!/bin/bash
# Regenerate the sbxdiff patch set from the working tree.
# Verifies: every patch reverse-applies, the area patches are a disjoint
# partition of the changed files, and nothing is missing from all.patch.
set -e
# Chromium checkout. Override with SBXDIFF_SRC=... if yours lives elsewhere.
SRC="${SBXDIFF_SRC:-$(cd "$(dirname "$0")/../../../.." && pwd)/src}"
[ -d "$SRC/.git" ] || { echo "not a Chromium checkout: $SRC (set SBXDIFF_SRC)" >&2; exit 1; }
P="$(cd "$(dirname "$0")" && pwd)"
cd "$SRC"

NEW="base/sbxdiff_net_store.cc base/sbxdiff_net_store.h base/sbxdiff_rand_stream.h
     base/sbxdiff_observable_clock.cc base/sbxdiff_observable_clock.h
     base/sbxdiff_body_hash.h
     third_party/blink/renderer/platform/scheduler/common/sbxdiff_virtual_time.cc
     third_party/blink/renderer/platform/scheduler/common/sbxdiff_virtual_time.h
     chrome/browser/headless/sbxdiff_net_replay.cc chrome/browser/headless/sbxdiff_net_replay.h
     chrome/browser/headless/sbxdiff_runner.cc chrome/browser/headless/sbxdiff_runner.h
     third_party/blink/renderer/core/sbxdiff/ third_party/blink/renderer/platform/bindings/sbxdiff/"
git add -N $NEW
trap 'cd "$SRC" && git reset -q' EXIT

rm -f "$P"/*.patch
mk() { n="$1"; shift; git diff -- "$@" > "$P/$n"; }

mk 01-host-build-fixes.patch build/config/apple/sdk_info.py build/mac/find_sdk.py \
   components/remote_cocoa/browser/scoped_cg_window_id.cc
mk 02-undetectability.patch components/embedder_support/user_agent_utils.cc
mk 03-base-and-switches.patch base/BUILD.gn base/base_switches.h \
   third_party/blink/common/switches.cc third_party/blink/public/common/switches.h \
   content/browser/renderer_host/render_process_host_impl.cc
mk 04-tracer.patch third_party/blink/renderer/platform/bindings/sbxdiff \
   third_party/blink/renderer/platform/BUILD.gn \
   third_party/blink/renderer/platform/bindings/exception_state.cc
mk 05-bindings-generator.patch third_party/blink/renderer/bindings/scripts/bind_gen/interface.py
mk 06-realm-identity.patch third_party/blink/renderer/bindings/core/v8/local_window_proxy.cc \
   third_party/blink/renderer/bindings/core/v8/worker_or_worklet_script_controller.cc
mk 07-determinism.patch base/rand_util_posix.cc base/sbxdiff_rand_stream.h \
   third_party/blink/renderer/platform/blob/blob_url.cc \
   third_party/blink/renderer/modules/netinfo/network_information.cc \
   base/sbxdiff_observable_clock.cc base/sbxdiff_observable_clock.h \
   gin/v8_platform.cc \
   services/network/mdns_responder.cc \
   services/network/p2p/socket_udp.cc \
   content/browser/service_host/utility_process_host.cc \
   third_party/blink/renderer/modules/crypto/crypto.cc \
   third_party/blink/renderer/core/page/page.cc \
   third_party/blink/renderer/core/timing/window_performance.cc \
   third_party/blink/renderer/core/timing/performance.cc \
   third_party/blink/renderer/core/timing/performance.h \
   third_party/blink/renderer/core/dom/events/event.cc \
   third_party/blink/renderer/core/timing/time_clamper.cc \
   third_party/blink/renderer/platform/network/form_data_encoder.cc \
   third_party/boringssl/src/crypto/rand/getentropy.cc \
   third_party/blink/renderer/platform/scheduler/common/thread_scheduler_base.cc \
   third_party/blink/renderer/platform/scheduler/common/thread_scheduler_base.h \
   third_party/blink/renderer/platform/scheduler/common/auto_advancing_virtual_time_domain.cc \
   third_party/blink/renderer/platform/scheduler/common/process_time_override_coordinator.cc \
   third_party/blink/renderer/platform/scheduler/common/process_time_override_coordinator.h \
   third_party/blink/renderer/platform/scheduler/main_thread/web_scoped_virtual_time_pauser.cc \
   third_party/blink/renderer/platform/scheduler/main_thread/main_thread_scheduler_impl.cc \
   third_party/blink/renderer/platform/scheduler/common/sbxdiff_virtual_time.cc \
   third_party/blink/renderer/platform/scheduler/common/sbxdiff_virtual_time.h \
   third_party/blink/renderer/platform/scheduler/worker/worker_thread_scheduler.cc \
   third_party/blink/renderer/platform/scheduler/worker/worker_thread_scheduler.h \
   third_party/blink/renderer/platform/scheduler/BUILD.gn
mk 08-runner.patch chrome/app/chrome_main_delegate.cc chrome/browser/headless/BUILD.gn \
   chrome/browser/headless/sbxdiff_runner.cc chrome/browser/headless/sbxdiff_runner.h \
   chrome/browser/ui/startup/startup_browser_creator_impl.cc
mk 09-network.patch base/sbxdiff_body_hash.h \
   base/sbxdiff_net_store.cc base/sbxdiff_net_store.h \
   chrome/browser/chrome_content_browser_client.cc \
   chrome/browser/headless/sbxdiff_net_replay.cc chrome/browser/headless/sbxdiff_net_replay.h \
   third_party/blink/renderer/core/sbxdiff third_party/blink/renderer/core/BUILD.gn \
   third_party/blink/renderer/core/probe/core_probes.json5 \
   third_party/blink/renderer/core/frame/local_frame.cc \
   third_party/blink/renderer/core/frame/local_frame.h \
   third_party/blink/renderer/platform/loader/fetch/resource_fetcher.cc
git diff > "$P/all.patch"

fail=0
for f in "$P"/0*.patch "$P"/all.patch; do
  git apply --check -R "$f" || { echo "FAIL reverse-apply: $(basename $f)"; fail=1; }
done
dupes=$(cat "$P"/0*.patch | grep '^diff --git' | sort | uniq -d)
[ -n "$dupes" ] && { echo "FAIL file in two area patches:"; echo "$dupes"; fail=1; }
missing=$(comm -23 <(grep '^diff --git' "$P/all.patch" | sort) \
                   <(cat "$P"/0*.patch | grep '^diff --git' | sort))
[ -n "$missing" ] && { echo "FAIL file missing from area patches:"; echo "$missing"; fail=1; }

n=$(grep -c '^diff --git' "$P/all.patch")
[ $fail -eq 0 ] && echo "OK: $n files, area patches are a disjoint partition, all reverse-apply"
exit $fail
