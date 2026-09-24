import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
  getPluginRegistryGatewaySuccessor,
  isPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { getPluginRegistryForContext, requireActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  DetachedTaskRuntimeOwnerRetiredError,
  type DetachedTaskLifecycleRuntime,
} from "./detached-task-runtime-contract.js";

export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return requireActivePluginRegistry().detachedTaskRuntimes[0]?.runtime;
}

/**
 * Core work retains its scoped owner; plugin work follows its exact live instance.
 * Settlement of already-admitted work may move from a retired generation to the
 * live one while core owns tasks in both. New work never leaves its admitting scope.
 */
export function captureDetachedTaskRuntimeOwner(options?: { settlement?: boolean }): {
  runtime: DetachedTaskLifecycleRuntime | undefined;
  assertCurrent: () => void;
} {
  const scoped = requireActivePluginRegistry();
  // Only the Gateway that published the retired scope supplies its successor;
  // another Gateway's process-active registry never inherits this work.
  const successor = () => getPluginRegistryGatewaySuccessor(scoped);
  const live = options?.settlement === true ? successor() : undefined;
  const adopted =
    live &&
    live !== scoped &&
    isPluginRegistryRetired(scoped) &&
    !scoped.detachedTaskRuntimes[0] &&
    !live.detachedTaskRuntimes[0]
      ? live
      : undefined;
  const registry = adopted ?? scoped;
  const currentRegistry = adopted ? successor : getPluginRegistryForContext;
  const registration = registry.detachedTaskRuntimes[0];
  const runtime = registration?.runtime;
  const pluginId = registration?.pluginId;
  const record = registration
    ? registry.plugins.find((candidate) => candidate.id === pluginId)
    : undefined;
  // Local runs own scoped handles without publishing a Gateway activation.
  // Core handles retain that scope; plugin callbacks follow their exact instance.
  const authority = capturePluginLifecycleAuthority(
    record ? getPluginRecordRegistry(registry, record) : registry,
    record,
    { scopedRuntime: getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry },
  );
  return {
    runtime,
    assertCurrent() {
      if (registration) {
        const owner = record ? getPluginRecordRegistry(registry, record) : undefined;
        if (
          authority?.() &&
          owner?.detachedTaskRuntimes.some(
            (candidate) => candidate.pluginId === pluginId && candidate.runtime === runtime,
          )
        ) {
          return;
        }
      } else if (
        authority?.() &&
        currentRegistry() === registry &&
        registry.detachedTaskRuntimes[0] === undefined
      ) {
        return;
      }
      throw new DetachedTaskRuntimeOwnerRetiredError();
    },
  };
}
