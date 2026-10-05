import unittest

from usage_summary import summarize


class UsageSummaryTests(unittest.TestCase):
    def test_requested_alias_is_preserved_without_inference(self):
        self.assertEqual(
            summarize({"modelUsage": {}}, "sonnet"),
            {"requested_model": "sonnet", "actual_models": [], "resolved": False},
        )

    def test_two_actual_models_are_sorted(self):
        self.assertEqual(
            summarize(
                {"modelUsage": {"zeta-test-model": {}, "alpha-test-model": {}}},
                "sonnet",
            ),
            {
                "requested_model": "sonnet",
                "actual_models": ["alpha-test-model", "zeta-test-model"],
                "resolved": True,
            },
        )

    def test_one_actual_model(self):
        self.assertEqual(
            summarize({"modelUsage": {"single-test-model": {}}}, "sonnet"),
            {
                "requested_model": "sonnet",
                "actual_models": ["single-test-model"],
                "resolved": True,
            },
        )

    def test_missing_model_usage_is_unresolved(self):
        self.assertEqual(
            summarize({}, "sonnet"),
            {"requested_model": "sonnet", "actual_models": [], "resolved": False},
        )

    def test_model_usage_list_is_unresolved(self):
        self.assertEqual(
            summarize({"modelUsage": ["alpha-test-model"]}, "sonnet"),
            {"requested_model": "sonnet", "actual_models": [], "resolved": False},
        )


if __name__ == "__main__":
    unittest.main()
