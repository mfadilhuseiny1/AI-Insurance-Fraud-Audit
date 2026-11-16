/*
 * Type declarations of the SDK shims, for the type check of a repository's TypeScript checks (runner.cjs typeCheck).
 * Ontology-shaped values (clients, objects, object sets, where clauses) are `any`: their shape depends on the Ontology,
 * which the check does not read — the object types imported from @ontology/sdk / @foundry/ontology-api are declared per
 * check as `any` values and types. Everything with a fixed shape (scalar aliases, edit batches, errors, the platform
 * SDK @osdk/foundry) is typed, so misuse of it is a type error.
 */

// ------------------------------------------------------------------ globals of the runtime and the unit tests

declare var process: any;
declare var require: any;
declare var module: any;
declare var exports: any;
declare var __dirname: string;
declare var __filename: string;
declare var Buffer: any;
type Buffer = any;

interface BsaiTestFn {
  (name: string, fn?: () => any): void;
  skip(name: string, fn?: () => any): void;
  todo(name: string, fn?: () => any): void;
  only(name: string, fn?: () => any): void;
}
interface BsaiDescribe {
  (name: string, fn: () => void): void;
  skip(name: string, fn: () => void): void;
  only(name: string, fn: () => void): void;
}
declare var describe: BsaiDescribe;
declare var it: BsaiTestFn;
declare var test: BsaiTestFn;
declare var expect: (actual: any) => any;
declare var beforeEach: (fn: () => any) => void;
declare var afterEach: (fn: () => any) => void;
declare var beforeAll: (fn: () => any) => void;
declare var afterAll: (fn: () => any) => void;

// ------------------------------------------------------------------ TypeScript v2: @osdk/functions, @osdk/client, @osdk/api

declare module "@osdk/functions" {
  export type Integer = number;
  export type Long = number;
  export type Short = number;
  export type Byte = number;
  export type Float = number;
  export type Double = number;
  export type Decimal = number;
  export type Timestamp = string;
  export type LocalDate = string;
  export type DateISOString = string;
  export type UserId = string;
  export type GroupId = string;
  export type Principal = { type: "user" | "group"; id: string } | any;
  export type Attachment = any;
  export type MediaItem = any;
  export type MediaReference = any;
  export type FunctionsMap<K = any, V = any> = Map<K, V> | Record<string, V>;
  export type Range<T = any> = { min?: T; max?: T };
  export type TwoDimensionalAggregation<K = any, V = any> = any;
  export type ThreeDimensionalAggregation<K = any, S = any, V = any> = any;
  export type Notification = any;
  export type NotificationLink = any;
  export type EmailNotification = any;
  export type PlatformNotification = any;
  export type CipherText = any;
  export type GeoPoint = any;
  export type GeoShape = any;
  export type Geometry = any;

  export namespace Edits {
    type Object<T = any> = any;
    type Interface<T = any> = any;
    type Link<A = any, L = any> = any;
  }
  export type Edits = any;
  export type OntologyEdit = any;

  export interface EditBatch<E = any> {
    create(type: any, properties?: any): void;
    update(object: any, properties: any): void;
    delete(object: any): void;
    link(source: any, link: string, target: any): void;
    unlink(source: any, link: string, target: any): void;
    getEdits(): E[];
  }
  export function createEditBatch<E = any>(client?: any): EditBatch<E>;

  export class UserFacingError extends Error {
    constructor(message?: string);
  }
}

declare module "@osdk/functions/experimental" {
  export type WriteableClient<E = any> = any;
}

declare module "@osdk/client" {
  export type Client = any;
  export type PlatformClient = any;
  export type ObjectSet<T = any, A = any, B = any, C = any> = any;
  export type Osdk<T = any, A = any, B = any, C = any> = any;
  export namespace Osdk {
    type Instance<T = any, A = any, B = any, C = any> = any;
  }
  export const Osdk: any;
  export type PageResult<T = any> = { data: T[]; nextPageToken?: string; totalCount?: string };
  export type WhereClause<T = any> = any;
  export type PropertyKeys<T = any> = string;
  export type InterfaceDefinition = any;
  export type ObjectTypeDefinition = any;
  export type QueryDefinition = any;
  export function isOk(result: any): boolean;
}

declare module "@osdk/api" {
  export type Osdk<T = any, A = any, B = any, C = any> = any;
  export namespace Osdk {
    type Instance<T = any, A = any, B = any, C = any> = any;
  }
  export type ObjectSet<T = any, A = any, B = any, C = any> = any;
  export type InterfaceDefinition = any;
  export type ObjectTypeDefinition = any;
  export type QueryDefinition = any;
  export type PropertyKeys<T = any> = string;
  export type WhereClause<T = any> = any;
}

// ------------------------------------------------------------------ TypeScript v1: @foundry/functions-api

declare module "@foundry/functions-api" {
  export type Integer = number;
  export type Long = number;
  export type Short = number;
  export type Byte = number;
  export type Float = number;
  export type Double = number;
  export type Decimal = number;
  export function Function(options?: any): any;
  export function OntologyEditFunction(options?: any): any;
  export function Query(options?: { apiName?: string } & Record<string, any>): any;
  export function Edits(...types: any[]): any;
  export class UserFacingError extends Error {
    constructor(message?: string);
  }
  export class FunctionsMap<K = any, V = any> extends Map<K, V> {}
  export interface Timestamp extends Date {
    [key: string]: any;
  }
  export const Timestamp: { new (value?: any): Timestamp; now(): Timestamp; fromISOString(s: string): Timestamp; fromJsDate(d: Date): Timestamp };
  export class LocalDate {
    constructor(iso: string);
    static now(): LocalDate;
    static fromISOString(s: string): LocalDate;
    static fromJsDate(d: Date): LocalDate;
    toISOString(): string;
    toJsDate(): Date;
    [key: string]: any;
  }
  export const Filters: any;
  export type Range<T = any> = any;
  export type TwoDimensionalAggregation<K = any, V = any> = any;
  export type ThreeDimensionalAggregation<K = any, S = any, V = any> = any;
  export type BucketKey = any;
  export type BucketValue = any;
  export type IRange<T = any> = any;
  export type Bucketing<K = any> = any;
  export type User = any;
  export type Group = any;
  export type Principal = any;
  export const Users: any;
  export const Groups: any;
  export type Attachment = any;
  export type GeoPoint = any;
  export type GeoShape = any;
  export type Notification = any;
  export const Notification: any;
  export type ShortNotification = any;
  export const ShortNotification: any;
  export type EmailNotificationContent = any;
  export const EmailNotificationContent: any;
  export type MediaItem = any;
}

// ------------------------------------------------------------------ the platform SDK: @osdk/foundry

declare module "@osdk/foundry.core" {
  export type PageToken = string;
  export type PageSize = number;
  export type UserId = string;
  export type PrincipalId = string;
  export type CreatedTime = string;
  export type UpdatedTime = string;
  export type CreatedBy = string;
  export type UpdatedBy = string;
  export type Size = number;
  export type SizeBytes = string;
  export interface PageParams {
    pageSize?: number;
    pageToken?: string;
  }
  export interface Page<T> {
    data: T[];
    nextPageToken?: string;
  }
  export class PalantirApiError extends Error {
    errorName?: string;
    errorCode?: string;
    statusCode?: number;
    parameters: Record<string, any>;
  }
}

declare module "@osdk/foundry.admin" {
  import type { Page, PageParams } from "@osdk/foundry.core";
  export type UserId = string;
  export type GroupId = string;
  export type Realm = string;
  export type OrganizationRid = string;
  export type UserStatus = "ACTIVE" | "DELETED" | "DEACTIVATED" | string;
  export type AttributeName = string;
  export type AttributeValues = string[];
  export interface User {
    id: UserId;
    username: string;
    givenName?: string;
    familyName?: string;
    /** givenName / familyName under the names some Foundry examples use */
    firstName?: string;
    lastName?: string;
    email?: string;
    realm: Realm;
    organization?: OrganizationRid;
    attributes: Record<AttributeName, AttributeValues>;
    status: UserStatus;
  }
  export interface Group {
    id: GroupId;
    name: string;
    description?: string;
    realm: Realm;
    organizations: OrganizationRid[];
    attributes: Record<AttributeName, AttributeValues>;
  }
  export interface GetUsersBatchRequestElement {
    userId: UserId;
  }
  export interface GetGroupsBatchRequestElement {
    groupId: GroupId;
  }
  export interface GetUsersBatchResponse {
    data: Record<UserId, User>;
  }
  export interface GetGroupsBatchResponse {
    data: Record<GroupId, Group>;
  }
  export namespace User {
    function getCurrent(client: any, $queryParams?: Record<string, any>): Promise<User>;
    function get(client: any, userId: UserId, $queryParams?: Record<string, any>): Promise<User>;
    function getBatch(client: any, body: GetUsersBatchRequestElement[], $queryParams?: Record<string, any>): Promise<GetUsersBatchResponse>;
  }
  export namespace Group {
    function get(client: any, groupId: GroupId, $queryParams?: Record<string, any>): Promise<Group>;
    function getBatch(client: any, body: GetGroupsBatchRequestElement[], $queryParams?: Record<string, any>): Promise<GetGroupsBatchResponse>;
  }
  export import Users = User;
  export import Groups = Group;
  export type ListUsersResponse = Page<User>;
  export type ListGroupsResponse = Page<Group>;
  export type ListParams = PageParams;
}
declare module "@osdk/foundry.admin/User" {
  import { Users } from "@osdk/foundry.admin";
  export const getCurrent: typeof Users.getCurrent;
  export const get: typeof Users.get;
  export const getBatch: typeof Users.getBatch;
}
declare module "@osdk/foundry.admin/Group" {
  import { Groups } from "@osdk/foundry.admin";
  export const get: typeof Groups.get;
  export const getBatch: typeof Groups.getBatch;
}

declare module "@osdk/foundry.datasets" {
  import type { Page, PageParams } from "@osdk/foundry.core";
  export type DatasetRid = string;
  export type FilePath = string;
  export type TransactionRid = string;
  export type BranchName = string;
  export type TableExportFormat = "ARROW" | "CSV";
  export interface Dataset {
    rid: DatasetRid;
    name: string;
    parentFolderRid?: string;
  }
  export interface File {
    path: FilePath;
    transactionRid: TransactionRid;
    sizeBytes?: string;
    updatedTime: string;
  }
  export interface FieldSchema {
    name: string;
    type: string;
    nullable: boolean;
  }
  export interface GetDatasetSchemaResponse {
    datasetRid: DatasetRid;
    schema: { fieldSchemaList: FieldSchema[] };
  }
  export interface ReadTableParams {
    format: TableExportFormat;
    branchName?: BranchName;
    columns?: string[];
    rowLimit?: number;
    startTransactionRid?: TransactionRid;
    endTransactionRid?: TransactionRid;
    preview?: boolean;
  }
  export interface FileParams {
    branchName?: BranchName;
    startTransactionRid?: TransactionRid;
    endTransactionRid?: TransactionRid;
  }
  export namespace Dataset {
    function get(client: any, datasetRid: DatasetRid): Promise<Dataset>;
    function readTable(client: any, datasetRid: DatasetRid, $queryParams: ReadTableParams): Promise<Response>;
    function getSchema(client: any, datasetRid: DatasetRid, $queryParams?: Record<string, any>): Promise<GetDatasetSchemaResponse>;
  }
  export namespace File {
    function list(client: any, datasetRid: DatasetRid, $queryParams?: FileParams & PageParams): Promise<Page<File>>;
    function get(client: any, datasetRid: DatasetRid, filePath: FilePath, $queryParams?: FileParams): Promise<File>;
    function content(client: any, datasetRid: DatasetRid, filePath: FilePath, $queryParams?: FileParams): Promise<Response>;
    function read(client: any, datasetRid: DatasetRid, filePath: FilePath, $queryParams?: FileParams): Promise<Response>;
  }
  export import Datasets = Dataset;
  export import Files = File;
  export type ListFilesResponse = Page<File>;
}
declare module "@osdk/foundry.datasets/Dataset" {
  import { Datasets } from "@osdk/foundry.datasets";
  export const get: typeof Datasets.get;
  export const readTable: typeof Datasets.readTable;
  export const getSchema: typeof Datasets.getSchema;
}
declare module "@osdk/foundry.datasets/File" {
  import { Files } from "@osdk/foundry.datasets";
  export const list: typeof Files.list;
  export const get: typeof Files.get;
  export const content: typeof Files.content;
  export const read: typeof Files.read;
}

declare module "@osdk/foundry.filesystem" {
  import type { Page, PageParams } from "@osdk/foundry.core";
  export type ResourceRid = string;
  export type FolderRid = string;
  export type ProjectRid = string;
  export type ResourcePath = string;
  export type ResourceType = string;
  export type TrashStatus = "DIRECTLY_TRASHED" | "ANCESTOR_TRASHED" | "NOT_TRASHED";
  export interface Resource {
    rid: ResourceRid;
    displayName: string;
    description?: string;
    path: ResourcePath;
    type: ResourceType;
    parentFolderRid?: FolderRid;
    projectRid?: ProjectRid;
    spaceRid: string;
    createdTime: string;
    updatedTime: string;
    trashStatus: TrashStatus;
    sizeBytes?: string;
  }
  export interface Folder {
    rid: FolderRid;
    displayName: string;
    description?: string;
    path: ResourcePath;
    parentFolderRid?: FolderRid;
    projectRid?: ProjectRid;
    spaceRid: string;
    createdTime: string;
    updatedTime: string;
    trashStatus: TrashStatus;
  }
  export interface Project {
    rid: ProjectRid;
    displayName: string;
    description?: string;
    path: ResourcePath;
    spaceRid: string;
    createdTime: string;
    updatedTime: string;
    trashStatus: TrashStatus;
  }
  export interface CreateFolderRequest {
    displayName: string;
    parentFolderRid: FolderRid;
  }
  export namespace Resource {
    function get(client: any, resourceRid: ResourceRid, $queryParams?: Record<string, any>): Promise<Resource>;
    function getByPath(client: any, $queryParams: { path: ResourcePath; preview?: boolean }): Promise<Resource>;
  }
  export namespace Folder {
    function get(client: any, folderRid: FolderRid, $queryParams?: Record<string, any>): Promise<Folder>;
    function children(client: any, folderRid: FolderRid, $queryParams?: PageParams & { preview?: boolean }): Promise<Page<Resource>>;
    function create(client: any, body: CreateFolderRequest, $queryParams?: Record<string, any>): Promise<Folder>;
  }
  export namespace Project {
    function get(client: any, projectRid: ProjectRid, $queryParams?: Record<string, any>): Promise<Project>;
  }
  export import Resources = Resource;
  export import Folders = Folder;
  export import Projects = Project;
}
declare module "@osdk/foundry.filesystem/Resource" {
  import { Resources } from "@osdk/foundry.filesystem";
  export const get: typeof Resources.get;
  export const getByPath: typeof Resources.getByPath;
}
declare module "@osdk/foundry.filesystem/Folder" {
  import { Folders } from "@osdk/foundry.filesystem";
  export const get: typeof Folders.get;
  export const children: typeof Folders.children;
  export const create: typeof Folders.create;
}
declare module "@osdk/foundry.filesystem/Project" {
  import { Projects } from "@osdk/foundry.filesystem";
  export const get: typeof Projects.get;
}

declare module "@osdk/foundry.ontologies" {
  import type { Page, PageParams } from "@osdk/foundry.core";
  export type OntologyIdentifier = string;
  export type ObjectTypeApiName = string;
  export type ActionTypeApiName = string;
  export type QueryApiName = string;
  export type LinkTypeApiName = string;
  export type PrimaryKeyValue = string | number | boolean;
  export type OntologyObjectV2 = Record<string, any> & { __apiName?: string; __primaryKey?: any; __rid?: string };
  export interface Ontology {
    apiName: string;
    displayName: string;
    description: string;
    rid: string;
  }
  export interface ListObjectsResponse {
    data: OntologyObjectV2[];
    nextPageToken?: string;
    totalCount: string;
  }
  export interface SearchObjectsRequest {
    where?: any;
    orderBy?: { fields: { field: string; direction?: "asc" | "desc" | string }[] };
    pageSize?: number;
    pageToken?: string;
    select?: string[];
    excludeRid?: boolean;
    derivedProperties?: Record<string, any>;
  }
  export interface AggregateObjectsRequest {
    aggregation: { type: string; name?: string; field?: string }[];
    groupBy?: { type?: string; field: string }[];
    where?: any;
  }
  export interface AggregateObjectsResponse {
    accuracy?: string;
    data: { group: Record<string, any>; metrics: { name: string; value: any }[] }[];
  }
  export interface ApplyActionRequest {
    parameters: Record<string, any>;
    options?: { mode?: "VALIDATE_ONLY" | "VALIDATE_AND_EXECUTE"; returnEdits?: "ALL" | "NONE" | string };
  }
  export namespace Ontology {
    function list(client: any): Promise<{ data: Ontology[] }>;
    function get(client: any, ontology: OntologyIdentifier): Promise<Ontology>;
  }
  export namespace ObjectTypes {
    function list(client: any, ontology: OntologyIdentifier, $queryParams?: PageParams): Promise<Page<any>>;
    function get(client: any, ontology: OntologyIdentifier, objectType: ObjectTypeApiName): Promise<any>;
  }
  export namespace OntologyObjects {
    function list(client: any, ontology: OntologyIdentifier, objectType: ObjectTypeApiName, $queryParams?: PageParams & { orderBy?: string; select?: string[] } & Record<string, any>): Promise<ListObjectsResponse>;
    function get(client: any, ontology: OntologyIdentifier, objectType: ObjectTypeApiName, primaryKey: PrimaryKeyValue, $queryParams?: { select?: string[] } & Record<string, any>): Promise<OntologyObjectV2>;
    function count(client: any, ontology: OntologyIdentifier, objectType: ObjectTypeApiName, $queryParams?: Record<string, any>): Promise<{ count: number }>;
    function search(client: any, ontology: OntologyIdentifier, objectType: ObjectTypeApiName, body: SearchObjectsRequest, $queryParams?: Record<string, any>): Promise<ListObjectsResponse>;
    function aggregate(client: any, ontology: OntologyIdentifier, objectType: ObjectTypeApiName, body: AggregateObjectsRequest, $queryParams?: Record<string, any>): Promise<AggregateObjectsResponse>;
  }
  export namespace LinkedObjects {
    function listLinkedObjects(client: any, ontology: OntologyIdentifier, objectType: ObjectTypeApiName, primaryKey: PrimaryKeyValue, linkType: LinkTypeApiName, $queryParams?: PageParams & Record<string, any>): Promise<{ data: OntologyObjectV2[]; nextPageToken?: string }>;
    function getLinkedObject(client: any, ontology: OntologyIdentifier, objectType: ObjectTypeApiName, primaryKey: PrimaryKeyValue, linkType: LinkTypeApiName, linkedObjectPrimaryKey: PrimaryKeyValue, $queryParams?: Record<string, any>): Promise<OntologyObjectV2>;
  }
  export namespace Actions {
    function apply(client: any, ontology: OntologyIdentifier, action: ActionTypeApiName, body: ApplyActionRequest, $queryParams?: Record<string, any>): Promise<any>;
    function applyBatch(client: any, ontology: OntologyIdentifier, action: ActionTypeApiName, body: { requests: { parameters: Record<string, any> }[]; options?: any }, $queryParams?: Record<string, any>): Promise<any>;
  }
  export namespace Queries {
    function execute(client: any, ontology: OntologyIdentifier, queryApiName: QueryApiName, body: { parameters: Record<string, any> }, $queryParams?: Record<string, any>): Promise<{ value: any }>;
  }
  export namespace Attachments {
    function get(client: any, attachmentRid: string): Promise<{ rid: string; filename: string; sizeBytes: string; mediaType: string }>;
    function read(client: any, attachmentRid: string): Promise<Response>;
  }
  export import Ontologies = Ontology;
  export import OntologiesV2 = Ontologies;
  export import ObjectType = ObjectTypes;
  export import ObjectTypesV2 = ObjectTypes;
  export import OntologyObject = OntologyObjects;
  export import OntologyObjectsV2 = OntologyObjects;
  export import LinkedObject = LinkedObjects;
  export import LinkedObjectsV2 = LinkedObjects;
  export import Action = Actions;
  export import ActionsV2 = Actions;
  export import Query = Queries;
  export import QueriesV2 = Queries;
  export import Attachment = Attachments;
  export import AttachmentsV2 = Attachments;
}

declare module "@osdk/foundry.functions" {
  export type QueryApiName = string;
  export interface ExecuteQueryRequest {
    parameters: Record<string, any>;
    version?: string;
  }
  export interface ExecuteQueryResponse {
    value: any;
  }
  export namespace Queries {
    function execute(client: any, queryApiName: QueryApiName, body: ExecuteQueryRequest, $queryParams?: { preview?: boolean } & Record<string, any>): Promise<ExecuteQueryResponse>;
  }
  export import Query = Queries;
}
declare module "@osdk/foundry.functions/Query" {
  import { Queries } from "@osdk/foundry.functions";
  export const execute: typeof Queries.execute;
}

declare module "@osdk/foundry" {
  export * as Admin from "@osdk/foundry.admin";
  export * as Datasets from "@osdk/foundry.datasets";
  export * as Filesystem from "@osdk/foundry.filesystem";
  export * as Ontologies from "@osdk/foundry.ontologies";
  export * as Functions from "@osdk/foundry.functions";
  export { PalantirApiError } from "@osdk/foundry.core";
}
