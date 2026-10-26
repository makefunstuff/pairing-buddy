CFLAGS = -std=c11 -Wall -Wextra -g

ring: main.o ring.o
	$(CC) -o $@ $^

clean:
	rm -f ring *.o
