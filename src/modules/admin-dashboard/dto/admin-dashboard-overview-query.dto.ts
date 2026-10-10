import {
  IsOptional,
  IsDateString,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

@ValidatorConstraint({ name: 'isFromBeforeTo', async: false })
class IsFromBeforeTo implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments) {
    const obj = args.object as AdminDashboardOverviewQueryDto;
    if (obj.from && obj.to) {
      return obj.from <= obj.to;
    }
    return true;
  }
  defaultMessage() {
    return '"from" must not be greater than "to"';
  }
}

export class AdminDashboardOverviewQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  @Validate(IsFromBeforeTo)
  to?: string;
}
