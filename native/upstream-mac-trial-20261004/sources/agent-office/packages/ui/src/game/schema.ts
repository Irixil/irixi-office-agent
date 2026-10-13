import { Schema, MapSchema, type } from '@colyseus/schema';

export class AgentState extends Schema {
    declare id: string;
    declare name: string;
    declare x: number;
    declare y: number;
    declare direction: string;
    declare action: string;
    declare currentTask: string;
    declare thought: string;
    declare mood: number;
    declare reputation: number;
    declare riskLevel: number;
    declare momentum: number;
}

type("string")(AgentState.prototype, "id");
type("string")(AgentState.prototype, "name");
type("number")(AgentState.prototype, "x");
type("number")(AgentState.prototype, "y");
type("string")(AgentState.prototype, "direction");
type("string")(AgentState.prototype, "action");
type("string")(AgentState.prototype, "currentTask");
type("string")(AgentState.prototype, "thought");
type("number")(AgentState.prototype, "mood");
type("number")(AgentState.prototype, "reputation");
type("number")(AgentState.prototype, "riskLevel");
type("number")(AgentState.prototype, "momentum");


export class OfficeState extends Schema {
    declare agents: MapSchema<AgentState>;
    declare officeTime: string;
    declare timeScale: number;
}

type({ map: AgentState })(OfficeState.prototype, "agents");
type("string")(OfficeState.prototype, "officeTime");
type("number")(OfficeState.prototype, "timeScale");
