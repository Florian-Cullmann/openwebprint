export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const missingDevice = () => new AppError(404, 'Gerät nicht gefunden.');
