/**
 * ParticipantProvider: resolves @names to participant info.
 *
 * Knows about all agents (from agents/*.coil) and the human user.
 */

import type { ParticipantProvider, ParticipantInfo } from 'coil-runtime/sdk';

export class SandboxParticipantProvider implements ParticipantProvider {
  private participants = new Map<string, ParticipantInfo>();

  registerAgent(name: string): void {
    this.participants.set(name, {
      id: name,
      metadata: { type: 'agent' },
    });
  }

  registerUser(name: string): void {
    this.participants.set(name, {
      id: name,
      metadata: { type: 'human' },
    });
  }

  isAgent(name: string): boolean {
    return this.participants.get(name)?.metadata.type === 'agent';
  }

  async resolve(name: string): Promise<ParticipantInfo | null> {
    return this.participants.get(name) ?? null;
  }
}
