package addopts

import "fmt"

const usage = "usage: factory add [--raw] [--trivial | --complexity trivial|complex] [intent...] [--verify <cmd...>] [--edit]"

type Parsed struct {
	Args       []string
	Raw        bool
	Complexity string
}

func Parse(args []string) (Parsed, error) {
	verifyIndex := index(args, "--verify")
	head := args
	var tail []string
	if verifyIndex >= 0 {
		head = args[:verifyIndex]
		tail = args[verifyIndex+1:]
	}
	if contains(tail, "--trivial") || contains(tail, "--complexity") {
		return Parsed{}, fail("complexity flags must appear before --verify")
	}

	cleaned := make([]string, 0, len(head))
	var raw bool
	var complexity string
	for i := 0; i < len(head); i++ {
		arg := head[i]
		switch arg {
		case "--raw":
			raw = true
		case "--trivial":
			next, err := setComplexity(complexity, "trivial")
			if err != nil {
				return Parsed{}, err
			}
			complexity = next
		case "--complexity":
			if i+1 >= len(head) || len(head[i+1]) >= 2 && head[i+1][:2] == "--" {
				return Parsed{}, fail("--complexity needs a value: trivial or complex")
			}
			value := head[i+1]
			if value != "trivial" && value != "complex" {
				return Parsed{}, fail(fmt.Sprintf("invalid complexity %q (expected trivial or complex)", value))
			}
			next, err := setComplexity(complexity, value)
			if err != nil {
				return Parsed{}, err
			}
			complexity = next
			i++
		default:
			cleaned = append(cleaned, arg)
		}
	}

	if verifyIndex >= 0 {
		cleaned = append(append(cleaned, "--verify"), tail...)
	}
	return Parsed{Args: cleaned, Raw: raw, Complexity: complexity}, nil
}

func setComplexity(current, next string) (string, error) {
	if current != "" && current != next {
		return "", fail(fmt.Sprintf("conflicting complexity flags: %s and %s", current, next))
	}
	return next, nil
}

func fail(message string) error {
	return fmt.Errorf("%s\n%s", usage, message)
}

func index(values []string, needle string) int {
	for i, value := range values {
		if value == needle {
			return i
		}
	}
	return -1
}

func contains(values []string, needle string) bool {
	return index(values, needle) >= 0
}
