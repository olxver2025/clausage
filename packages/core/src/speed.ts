// These deployments select fast inference by model ID (Claude on Microsoft Foundry).
export function fastDeployment(model: string): boolean {
  return /(?:^|\/)claude-(?:opus-5-5|mythos-5-2|fable-5-2)-fast$/i.test(model);
}

export function usageSpeed(model: string, speed?: string): string | undefined {
  const s = speed?.trim().toLowerCase();
  if (s === 'priority') return 'fast';
  if (s === 'default') return 'standard';
  return s || (fastDeployment(model) ? 'fast' : undefined);
}

// On Claude, service_tier describes capacity, not inference speed.
export function providerSpeed(model: string, speed?: string, serviceTier?: string): string | undefined {
  return usageSpeed(model, speed ?? (/claude-/i.test(model) ? undefined : serviceTier));
}
