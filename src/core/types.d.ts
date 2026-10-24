export type Provider = 'manual' | 'unagent' | 'codex' | 'claude' | 'workbuddy' | 'harness';
export type RunStatus = 'queued'|'running'|'waiting_dependency'|'waiting_question'|'waiting_approval'|'completed'|'failed'|'cancel_requested'|'cancelled'|'interrupted'|'uncertain'|'paused';
export interface Participant {id:string;name:string;provider:Provider;workspace:string;purpose:string;autoExecute:boolean;allowedPeers:string[];revokedAt:number|null;createdAt:number;updatedAt:number;}
export interface Thread {id:string;participantIds:string[];title:string;createdAt:number;updatedAt:number;}
export interface Message {id:string;threadId:string;senderId:string;recipientId:string;content:string;createdAt:number;ackedAt:number|null;}
export interface Artifact {path:string;name:string;bytes:number;}
export interface Question {id:string;runId:string;kind:'clarification'|'approval';text:string;options?:string[];status:'open'|'answered'|'cancelled';createdAt:number;answer?:string;approved?:boolean;}
export interface Run {id:string;threadId:string;senderId:string;recipientId:string;workspace:string;content:string;status:RunStatus;round:number;attemptId:string;rootRunId:string;parentRunId:string|null;dependencyRunIds:string[];nativeSessionId?:string;result?:{text:string;artifacts:Artifact[]};question?:Question;error?:string;deadlineAt:number;createdAt:number;updatedAt:number;revision:number;}
export interface Event {id:number;type:string;runId?:string;threadId?:string;createdAt:number;data:unknown;}
export interface Actor {admin?:boolean;participantId?:string;}
export interface Adapter {id:Provider;capabilities:Record<string,boolean>;health(config:Record<string,unknown>):Promise<{state:string;version?:string;message?:string}>;execute(ctx:unknown):Promise<{text:string;artifacts?:string[];nativeSessionId?:string;nativeBinding?:unknown}>;cancel(ctx:unknown):Promise<{stopped:boolean}>;recover?(ctx:unknown):Promise<unknown>;}
