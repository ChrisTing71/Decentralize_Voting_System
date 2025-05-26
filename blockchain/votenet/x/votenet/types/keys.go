package types

const (
	// ModuleName defines the module name
	ModuleName = "votenet"

	// StoreKey defines the primary module store key
	StoreKey = ModuleName

	// MemStoreKey defines the in-memory store key
	MemStoreKey = "mem_votenet"
)

var (
	ParamsKey = []byte("p_votenet")
)

func KeyPrefix(p string) []byte {
	return []byte(p)
}
