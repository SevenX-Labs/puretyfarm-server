export interface IProfileStorageService {
  uploadAvatar(userId: string, file: Express.Multer.File): Promise<string>;
  deleteAvatar(fileUrlOrKey: string): Promise<void>;
}
