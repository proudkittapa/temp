package main

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type display struct {
	Product []string `json:"Product"`
}

var mp map[int]string = make(map[int]string)

type data struct {
	Name     string `json:"name"`
	Quantity int    `json:"quantity"`
	Price    int    `json:"price"`
}

var (
	db          *sql.DB
	q           int
	newQuantity int
	mutex       sync.Mutex
)

type respond struct {
	Msg string `json:"msg"`
}

var count int = 0

func main() {
	db, _ = sql.Open("mysql", "root:62011139@tcp(127.0.0.1:3306)/prodj")
	li, err := net.Listen("tcp", ":8080")
	if err != nil {
		log.Fatalln(err.Error())
		// fmt.Println("count error:", count)
	}
	defer li.Close()
	for {
		conn, err := li.Accept()

		if err != nil {
			log.Fatalln(err.Error())
			continue
		}
		go handle(conn)
	}
}

func handle(conn net.Conn) {
	defer conn.Close()
	req(conn)

}

func req(conn net.Conn) {
	defer conn.Close()
	buffer := make([]byte, 256)
	for {
		n, err := conn.Read(buffer)
		if err != nil {
			// fmt.Println("error req")
			fmt.Fprintln(os.Stderr, err)
		}
		message := string(buffer[:n])
		// fmt.Println(message)
		// fmt.Fprintln(os.Stderr, message)
		// fmt.Println("message", message)
		if !strings.Contains(message, "HTTP") {
			if _, err := conn.Write([]byte("Recieved\n")); err != nil {
				log.Printf("failed to respond to client: %v\n", err)
			}
			break
		}
		headers := strings.Split(message, "\n")
		// fmt.Println("length header", len(headers))
		// fmt.Println("body", headers[9])
		method := (strings.Split(headers[0], " "))[0]
		path := (strings.Split(headers[0], " "))[1]

		// fmt.Println(method , path)
		p := strings.Split(path, "/")
		// fmt.Println("Split path", p)
		// fmt.Println("length", len(p))
		if p[1] == "" {
			home(conn, method)
		} else if p[1] == "products" {
			if (len(p) > 2) && (p[2] != "") {
				result := getJson(message)
				// fmt.Println(result)
				productWithID(conn, method, p[2], result)
			} else {
				products(conn, method)
			}

		}
	}

}

func getJson(message string) data {
	var result data
	if strings.ContainsAny(string(message), "}") {

		r, _ := regexp.Compile("{([^)]+)}")
		// match, _ := regexp.MatchString("{([^)]+)}", message)
		// fmt.Println(r.FindString(message))
		match := r.FindString(message)
		fmt.Println(match)
		// match = "`\n"+match+"\n`"
		fmt.Printf("%T\n", match)
		json.Unmarshal([]byte(match), &result)
		// fmt.Println("data", result)
		// fmt.Println("Name", result.Name)
		// fmt.Println("Quantity", result.Quantity)
		// fmt.Println("Price", result.Price)
	}
	return result
}

func home(conn net.Conn, method string) {
	fmt.Println("home")
	if method == "GET" {
		// d := getFile()
		c := "text/html"
		d := getFile()
		send(conn, d, c)
	}
}

func products(conn net.Conn, method string) {
	// fmt.Println("products")
	// fmt.Fprintln(os.Stderr, "products")
	if method == "GET" {
		d := display_pro()
		// d := "asd"
		c := "application/json"
		send(conn, d, c)
	}
}

func productWithID(conn net.Conn, method string, id string, result data) {
	fmt.Println("ID")
	i, _ := strconv.Atoi(id)
	if method == "GET" {
		d := db_query(i)
		// d := "abc"
		c := "application/json"
		send(conn, d, c)
	} else if method == "POST" {
		success := postPreorder(i, result.Quantity)
		msg := ""
		if success == true {
			msg = "success"
		} else {
			msg = "fail"
		}

		jsonStr := respond{Msg: msg}
		jsonData, err := json.Marshal(jsonStr)
		if err != nil {
			fmt.Println("error post", err)
		}
		d := string(jsonData)
		c := "application/json"
		send(conn, d, c)
	}

}

func getFile() string {
	f, err := os.Open("index.html")

	if err != nil {
		fmt.Println("File reading error", err)

	}
	defer func() {
		if err := f.Close(); err != nil {
			panic(err)
		}
	}()
	chunksize := 512
	reader := bufio.NewReader(f)
	part := make([]byte, chunksize)
	buffer := bytes.NewBuffer(make([]byte, 0))
	var bufferLen int
	for {
		count, err := reader.Read(part)
		if err != nil {
			break
		}
		bufferLen += count
		buffer.Write(part[:count])
	}
	// fmt.Println("home")
	return buffer.String()
	// contentType = "text/html"
	// headers = fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Length: %d\r\nContent-Type: %s\r\n\n%s", bufferLen, contentType, buffer)

}

func send(conn net.Conn, d string, c string) {
	fmt.Fprintf(conn, createHeader(d, c))
}

//create header function
func createHeader(d string, contentType string) string {

	contentLength := len(d)

	headers := fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Length: %d\r\nContent-Type: %s\r\n\n%s", contentLength, contentType, d)
	// fmt.Println(headers)
	return headers
}

func checkErr(err error) {
	if err != nil {
		fmt.Println("check err", err)
	}
}

func cache(id int) string {
	if val, ok := mp[id]; ok {
		return val
	} else {
		return db_query(id)
	}
}

func db_query(id int) string {
	start := time.Now()
	// db, err := sql.Open("mysql", "root:62011139@tcp(127.0.0.1:3306)/prodj")
	// checkErr(err)

	// fmt.Println("----------MISS----------")

	rows, err := db.Query("SELECT name, quantity_in_stock, unit_price FROM products WHERE product_id = " + strconv.Itoa(id))
	checkErr(err)

	for rows.Next() {
		var name string
		var quantity int
		var price int
		err = rows.Scan(&name, &quantity, &price)

		result := data{Name: name, Quantity: quantity, Price: price}
		byteArray, err := json.Marshal(result)
		checkErr(err)

		mp[id] = string(byteArray)

	}
	val := mp[id]
	fmt.Printf("time query from db (MISS): %v\n", time.Since(start))
	// fmt.Println(val)
	return val
}

func display_pro() (val string) {
	var l []string
	for i := 1; i <= 10; i++ {
		val := db_query(i)
		l = append(l, val)
	}

	result := display{Product: l}

	byteArray, err := json.Marshal(result)
	checkErr(err)

	val = string(byteArray)
	fmt.Println(val)
	return
}

func getQuantity(t chan int, id int) {
	start := time.Now()
	info := cache(id)

	var quan data
	err := json.Unmarshal([]byte(info), &quan)
	checkErr(err)
	t <- quan.Quantity

	fmt.Printf("time query from cache: %v\n", time.Since(start))
	fmt.Println("Quantity: ", quan.Quantity)

}

func decrement(t chan int, transactionC chan int, orderQuantity int, id int) {
	start := time.Now()
	quantity := <-t // channel from getQuantity
	newQuantity := quantity - orderQuantity
	if newQuantity < 0 {
		transactionC <- 0
		return
	}
	fmt.Println("New Quantity: ", newQuantity)
	db.Exec("update products set quantity_in_stock = ? where product_id = ? ", newQuantity, id)

	if _, ok := mp[id]; ok {
		rows, err := db.Query("SELECT name, unit_price FROM products WHERE product_id = " + strconv.Itoa(id))
		checkErr(err)
		var name string
		var price int
		err = rows.Scan(&name, &price)

		result := data{Name: name, Quantity: newQuantity, Price: price}
		byteArray, err := json.Marshal(result)
		checkErr(err)

		mp[id] = string(byteArray)
	}

	transactionC <- 0
	fmt.Printf("time decrement: %v\n", time.Since(start))

}

func insert(user string, id int, q int) {
	start := time.Now()
	db.Exec("INSERT INTO order_items(username, product_id, quantity) VALUES (?, ?, ?)", user, id, q)
	fmt.Printf("time insert: %v\n", time.Since(start))
}

func preorder(end chan int, user string, productId int, orderQuantity int) {
	// fmt.Printf("start\n")
	start := time.Now()
	transactionC := make(chan int)
	t := make(chan int)
	mutex.Lock()
	go insert(user, productId, orderQuantity)
	go getQuantity(t, productId)
	go decrement(t, transactionC, orderQuantity, productId)
	<-transactionC // wait for all go routines
	mutex.Unlock()
	fmt.Printf("time: %v\n", time.Since(start))
	fmt.Println("---------------")

	num, _ := strconv.Atoi(user)
	end <- num
	return
}

func postPreorder(id int, quantity int) bool {
	//db, _ = sql.Open("mysql", "root:62011212@tcp(127.0.0.1:3306)/prodj")
	//defer db.Close()
	n := 100 //
	end := make(chan int, n)
	start2 := time.Now()

	go preorder(end, "1", id, quantity)

	<-end

	fmt.Printf("Total time: %v\n", time.Since(start2))

	return true
}
