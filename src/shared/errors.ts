export class R3DoctorError extends Error {
  readonly exitCode: 2 | 1;

  constructor(message: string, exitCode: 2 | 1 = 2) {
    super(message);
    this.name = 'R3DoctorError';
    this.exitCode = exitCode;
  }
}

export class ConfigError extends R3DoctorError {
  readonly configPath: string;

  constructor(configPath: string, reason: string) {
    super(`config error at ${configPath}: ${reason}`);
    this.name = 'ConfigError';
    this.configPath = configPath;
  }
}

export class BaselineSaveError extends R3DoctorError {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineSaveError';
  }
}

export class IntakeError extends R3DoctorError {
  constructor(message: string) {
    super(message);
    this.name = 'IntakeError';
  }
}
