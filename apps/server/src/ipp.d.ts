declare module '@sealsystems/ipp' {
  const ipp: {
    Printer(
      url: string,
      options: { version: string; timeout: number; uri?: string },
    ): {
      execute(
        operation: string,
        message: Record<string, unknown>,
        callback: (
          error: Error | null,
          response: { statusCode: string; [key: string]: unknown },
        ) => void,
      ): void;
    };
  };
  export default ipp;
}
