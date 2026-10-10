export interface IProfileStorageService {
  /**
   * Uploads an avatar to the PRIVATE bucket and returns the permanent storage
   * OBJECT PATH (e.g. `avatars/customers/{userId}-{timestamp}.jpg`).
   * Never returns a public or signed URL.
   */
  uploadAvatar(userId: string, file: Express.Multer.File): Promise<string>;

  /**
   * Deletes the object at the given storage path. Operates only on
   * server-generated `avatars/customers/...` paths.
   */
  deleteAvatar(objectPath: string): Promise<void>;

  /**
   * Generates a short-lived signed URL for a private object path so the
   * frontend can display it directly. The signed URL is never persisted.
   */
  createSignedUrl(
    objectPath: string,
    expiresInSeconds: number,
  ): Promise<string>;
}
