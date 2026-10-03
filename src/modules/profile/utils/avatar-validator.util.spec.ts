import { BadRequestException } from "@nestjs/common";
import {
  validateAvatarFile,
  MAX_AVATAR_SIZE,
} from "./avatar-validator.util";

const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const webp = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

const file = (o: Partial<Express.Multer.File>): Express.Multer.File =>
  ({
    fieldname: "avatar",
    originalname: "x",
    mimetype: "image/jpeg",
    size: 1024,
    buffer: jpeg,
    ...o,
  }) as Express.Multer.File;

describe("validateAvatarFile", () => {
  it("A/B/C. accepts matching JPEG, PNG, WEBP", () => {
    expect(() => validateAvatarFile(file({ mimetype: "image/jpeg", buffer: jpeg }))).not.toThrow();
    expect(() => validateAvatarFile(file({ mimetype: "image/png", buffer: png }))).not.toThrow();
    expect(() => validateAvatarFile(file({ mimetype: "image/webp", buffer: webp }))).not.toThrow();
  });

  it("D. accepts a file exactly at the 3 MB limit", () => {
    expect(() => validateAvatarFile(file({ size: MAX_AVATAR_SIZE }))).not.toThrow();
  });

  it("E. rejects a file over 3 MB", () => {
    expect(() => validateAvatarFile(file({ size: MAX_AVATAR_SIZE + 1 }))).toThrow(
      BadRequestException,
    );
  });

  it("rejects a missing file", () => {
    expect(() => validateAvatarFile(undefined)).toThrow(BadRequestException);
  });

  it("G/K. rejects unsupported MIME (SVG)", () => {
    expect(() =>
      validateAvatarFile(file({ mimetype: "image/svg+xml", buffer: Buffer.from("<svg/>") })),
    ).toThrow(BadRequestException);
  });

  it("L. rejects PDF", () => {
    expect(() =>
      validateAvatarFile(
        file({ mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4") }),
      ),
    ).toThrow(BadRequestException);
  });

  it("H/I. rejects image/jpeg whose bytes are actually PNG", () => {
    expect(() =>
      validateAvatarFile(file({ mimetype: "image/jpeg", buffer: png })),
    ).toThrow(/do not match the declared image type/);
  });

  it("H/J. rejects image/png whose bytes are actually JPEG", () => {
    expect(() =>
      validateAvatarFile(file({ mimetype: "image/png", buffer: jpeg })),
    ).toThrow(/do not match the declared image type/);
  });

  it("rejects allowed MIME with junk bytes (no valid signature)", () => {
    expect(() =>
      validateAvatarFile(
        file({ mimetype: "image/jpeg", buffer: Buffer.from("not an image!") }),
      ),
    ).toThrow(BadRequestException);
  });
});
