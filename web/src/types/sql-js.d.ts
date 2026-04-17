declare module "sql.js" {
  type SqlJsDatabase = {
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    run(sql: string): void;
    export(): Uint8Array;
    close(): void;
  };

  type SqlJsStatic = {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  };

  type InitSqlJs = (config?: { wasmBinary?: Uint8Array; locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;

  const initSqlJs: InitSqlJs;
  export default initSqlJs;
}
