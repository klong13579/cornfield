export type TopicStatus = "planned" | "in-progress" | "review" | "testing" | "shipped" | "deferred";

export interface TaskTopic {
	id: string;
	name: string;
	brief: string;
	description?: string;
	status: TopicStatus;
	progress?: number;
	started?: string;
	target?: string;
	modules?: string[];
	design?: { spec?: string; plan?: string };
	references?: { name: string; url: string; note?: string }[];
	github?: { issues?: string[]; prs?: string[] };
	notes?: string;
	tags?: string[];
}

export interface TaskBoard {
	getTopics(): TaskTopic[];
	getTopic(id: string): TaskTopic | undefined;
	getByStatus(status: TopicStatus): TaskTopic[];
	getByModule(module: string): TaskTopic[];
	getByTag(tag: string): TaskTopic[];
	addTopic(topic: TaskTopic): void;
	load(yamlContent: string, path?: string): void;
	save(yamlPath: string): Promise<void>;
	reload(yamlPath: string): Promise<void>;
}
