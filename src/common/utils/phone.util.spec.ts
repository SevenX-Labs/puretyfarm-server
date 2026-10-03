import { BadRequestException } from '@nestjs/common';
import { normalizeMobile } from './phone.util';

describe('Phone Utility', () => {
  it('should normalize 10-digit mobile number to canonical +91 format', () => {
    expect(normalizeMobile('9876543210')).toBe('+919876543210');
  });

  it('should preserve and normalize already prefixed +91 numbers', () => {
    expect(normalizeMobile('+919876543210')).toBe('+919876543210');
  });

  it('should normalize numbers starting with 91 (12 digits)', () => {
    expect(normalizeMobile('919876543210')).toBe('+919876543210');
  });

  it('should normalize numbers starting with leading 0 (11 digits)', () => {
    expect(normalizeMobile('09876543210')).toBe('+919876543210');
  });

  it('should strip whitespace, dashes, and parentheses', () => {
    expect(normalizeMobile('+91 98765-43210')).toBe('+919876543210');
    expect(normalizeMobile('(98765) 43210')).toBe('+919876543210');
  });

  it('should ensure same customer represents both 9876543210 and +919876543210 (duplicate prevention)', () => {
    const raw = normalizeMobile('9876543210');
    const withPrefix = normalizeMobile('+919876543210');
    expect(raw).toBe(withPrefix);
  });

  it('should throw BadRequestException for invalid phone numbers', () => {
    expect(() => normalizeMobile('')).toThrow(BadRequestException);
    expect(() => normalizeMobile('12345')).toThrow(BadRequestException);
    expect(() => normalizeMobile('1234567890')).toThrow(BadRequestException); // starts with 1
    expect(() => normalizeMobile('abcdefghij')).toThrow(BadRequestException);
  });
});
