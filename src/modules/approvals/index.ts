/**
 * Approvals module — admin approval primitive + response plumbing.
 *
 * Default-tier module. Ships with main. Other modules depend on it by
 * importing `requestApproval` / `registerApprovalHandler` from this module.
 *
 * Registers:
 *   - A response handler that claims pending_approvals rows and dispatches
 *     to whatever module registered for the row's `action` string. Also
 *     resolves in-memory OneCLI credential approvals.
 *   - An adapter-ready callback that starts the OneCLI manual-approval handler
 *     once the delivery adapter is set.
 *   - A shutdown callback that stops the OneCLI handler cleanly.
 *
 * Self-mod flows (install_packages, add_mcp_server) moved out to
 * `src/modules/self-mod/` in PR #7 — they now register delivery actions
 * + approval handlers via this module's public API.
 */
import { onDeliveryAdapterReady } from '../../delivery.js';
import { registerResponseHandler, onShutdown } from '../../response-registry.js';
import { handleApprovalsResponse } from './response-handler.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';

// Public API re-exports so consumers import from the module root.
export { requestApproval, registerApprovalHandler, notifyAgent } from './primitive.js';
export type { ApprovalHandler, ApprovalHandlerContext, RequestApprovalOptions } from './primitive.js';

registerResponseHandler(handleApprovalsResponse);

// This fork uses the native credential proxy, not the OneCLI gateway, so the
// OneCLI manual-approval long-poller has nothing to talk to and would just log
// noise at boot. Keep it available behind an opt-in flag for installs that do
// run a OneCLI gateway (set NANOCLAW_ONECLI_APPROVALS=true).
const ONECLI_APPROVALS_ENABLED = process.env.NANOCLAW_ONECLI_APPROVALS === 'true';

onDeliveryAdapterReady((adapter) => {
  if (ONECLI_APPROVALS_ENABLED) startOneCLIApprovalHandler(adapter);
});

onShutdown(() => {
  stopOneCLIApprovalHandler();
});
