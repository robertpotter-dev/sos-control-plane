import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const OPERATOR_PREFERENCES_RELATIVE_PATH = join('.sos', 'operator-preferences.json');

export function validateOperatorPreferences(root) {
    const filePath = join(root, OPERATOR_PREFERENCES_RELATIVE_PATH);
    if (!existsSync(filePath)) {
        return { exists: false, valid: true, filePath, preferences: [], errors: [] };
    }

    let parsed;
    try {
        parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (error) {
        return {
            exists: true,
            valid: false,
            filePath,
            preferences: [],
            errors: [`Invalid JSON: ${error.stack}`]
        };
    }

    const errors = [];
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push('Root value must be an object containing only a preferences array.');
    } else {
        const keys = Object.keys(parsed);
        if (keys.length !== 1 || keys[0] !== 'preferences') {
            errors.push('Root object must contain exactly one key: preferences.');
        }
        if (!Array.isArray(parsed.preferences)) {
            errors.push('preferences must be an array.');
        } else {
            parsed.preferences.forEach((preference, index) => {
                if (typeof preference !== 'string' || preference.trim().length === 0) {
                    errors.push(`preferences[${index}] must be a non-empty string.`);
                }
            });
        }
    }

    return {
        exists: true,
        valid: errors.length === 0,
        filePath,
        preferences: errors.length === 0 ? parsed.preferences : [],
        errors
    };
}
