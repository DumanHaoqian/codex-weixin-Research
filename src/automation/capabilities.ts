export type CapabilityStatus = { ready: boolean; reason?: string };
export type AutomationCapabilities = {
  storage: CapabilityStatus;
  agent: CapabilityStatus;
  remote: CapabilityStatus;
  gpuReserve: CapabilityStatus;
};

// Availability is evidence, not a promise based on installed tools or login state.
export function automationCapabilities(nodeVersion = process.versions.node): AutomationCapabilities {
  return {
    storage: Number(nodeVersion.split('.')[0]) >= 24
      ? { ready: true }
      : { ready: false, reason: 'Automation storage requires Node.js >=24' },
    agent: { ready: false, reason: 'Restricted analysis profile has not been verified' },
    remote: { ready: false, reason: 'Authorized background MCP transport is not configured' },
    gpuReserve: { ready: false, reason: 'Remote expiry and GPU identity protocol are not verified' }
  };
}
