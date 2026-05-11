package polariswebhook

import (
	"strconv"
	"time"
)

func parseTs(s string) time.Time {
	v, _ := strconv.ParseInt(s, 10, 64)
	return time.UnixMilli(v)
}
