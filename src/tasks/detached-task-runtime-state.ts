import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
  isPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import {
  getActivePluginRegistry,
  getPluginRegistryForContext,
  requireActivePluginRegistry,
} from "../plugins/runtime.js";
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

/** Core work retains its scoped owner until that generation retires; plugin work follows its exact live instance. */
export function captureDetachedTaskRuntimeOwner(): {
  runtime: DetachedTaskLifecycleRuntime | undefined;
  assertCurrent: () => void;
} {
  const scoped = requireActivePluginRegistry();
  const live = getActivePluginRegistry();
  // Detached work can outlive the plugin generation that admitted it. Core owns
  // settlement in both generations, so a retired scope settles on the live one.
  const adopted =
    live &&
    isPluginRegistryRetired(scoped) &&
    !scoped.detachedTaskRuntimes[0] &&
    !live.detachedTaskRuntimes[0]
      ? live
      : undefined;
  const registry = adopted ?? scoped;
  const currentRegistry = adopted ? getActivePluginRegistry : getPluginRegistryForContext;
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
