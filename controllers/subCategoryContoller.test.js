"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const SubCategory = require("../models/SubCategory");
const { getSubCategoriesByCategoryIds } = require("./subCategoryContoller");

test("getSubCategoriesByCategoryIds returns an empty successful result", async () => {
  const originalFind = SubCategory.find;

  try {
    SubCategory.find = () => {
      const query = {
        populate: () => query,
        select: async () => [],
      };
      return query;
    };

    let statusCode = 500;
    let responseBody;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };

    await getSubCategoriesByCategoryIds(
      { method: "POST", body: { categoryIds: ["6a730c0d8a2674d6e67cab7d"] } },
      res,
    );

    assert.equal(statusCode, 200);
    assert.deepEqual(responseBody, { data: {} });
  } finally {
    SubCategory.find = originalFind;
  }
});
