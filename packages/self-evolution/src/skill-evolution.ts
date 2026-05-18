/**
 * Mutation rate control for skill evolution.
 * Limits how many skills can change per evolution cycle.
 */

export interface MutationControl {
	maxMutationsPerCycle: number;
	maxNewSkillsPerCycle: number;
	maxDeprecationsPerCycle: number;
}

export const DEFAULT_MUTATION_CONTROL: MutationControl = {
	maxMutationsPerCycle: 5,
	maxNewSkillsPerCycle: 3,
	maxDeprecationsPerCycle: 2,
};

export class MutationController {
	#control: MutationControl;
	#cycleMutations = 0;
	#cycleNewSkills = 0;
	#cycleDeprecations = 0;

	constructor(control: Partial<MutationControl> = {}) {
		this.#control = { ...DEFAULT_MUTATION_CONTROL, ...control };
	}

	canMutate(): boolean {
		return this.#cycleMutations < this.#control.maxMutationsPerCycle;
	}

	canAddSkill(): boolean {
		return this.#cycleNewSkills < this.#control.maxNewSkillsPerCycle;
	}

	canDeprecate(): boolean {
		return this.#cycleDeprecations < this.#control.maxDeprecationsPerCycle;
	}

	recordMutation(): void {
		this.#cycleMutations++;
	}
	recordNewSkill(): void {
		this.#cycleNewSkills++;
	}
	recordDeprecation(): void {
		this.#cycleDeprecations++;
	}

	resetCycle(): void {
		this.#cycleMutations = 0;
		this.#cycleNewSkills = 0;
		this.#cycleDeprecations = 0;
	}

	getStats() {
		return {
			mutations: this.#cycleMutations,
			maxMutations: this.#control.maxMutationsPerCycle,
			newSkills: this.#cycleNewSkills,
			maxNewSkills: this.#control.maxNewSkillsPerCycle,
			deprecations: this.#cycleDeprecations,
			maxDeprecations: this.#control.maxDeprecationsPerCycle,
		};
	}
}
