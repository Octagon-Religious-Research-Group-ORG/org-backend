import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * Length in UTF-16 units, which is what Mongoose's `maxlength` counts.
 * class-validator's `@Length` counts code points, so an emoji counts once
 * there and twice at the database: text could pass here and fail at the save.
 */
export function Utf16Length(
  min: number,
  max: number,
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'utf16Length',
      constraints: [min, max],
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          value.length >= min &&
          value.length <= max,
        // Names the field only: the value is what a member typed.
        defaultMessage: () =>
          `Each entry must be between ${min} and ${max} characters long.`,
      },
    },
    options,
  );
}
