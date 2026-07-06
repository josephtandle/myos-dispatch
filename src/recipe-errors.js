class RecipeError extends Error {
  constructor(message, { code = "RECIPE_ERROR", details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

class RecipeInputError extends RecipeError {
  constructor(message, details = null) {
    super(message, { code: "RECIPE_INPUT_ERROR", details });
  }
}

class RecipeFallbackError extends RecipeError {
  constructor(message, details = null) {
    super(message, { code: "RECIPE_FALLBACK", details });
  }
}

class RecipeDependencyError extends RecipeError {
  constructor(message, details = null) {
    super(message, { code: "RECIPE_DEPENDENCY_ERROR", details });
  }
}

module.exports = {
  RecipeDependencyError,
  RecipeError,
  RecipeFallbackError,
  RecipeInputError,
};
