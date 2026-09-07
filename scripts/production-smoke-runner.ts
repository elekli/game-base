/** 沒有獨立、驗簽的 smoke principal、route 與固定 canary schema 時，禁止發出任何請求。 */
export class ProductionSmokePrerequisiteError extends Error {
  constructor() {
    super(
      "Production smoke is disabled until its signed principal, route, and fixed canary schema are approved.",
    );
    this.name = "ProductionSmokePrerequisiteError";
  }
}

/**
 * 現階段固定停發。輸入刻意不解析，避免呼叫端以自報狀態解除 repository contract。
 */
export function createProductionSmokeRunner(): never {
  throw new ProductionSmokePrerequisiteError();
}
